import BinarySearch from '../utils/binary-search';
import { BufferHelper } from '../media-source-api/buffer-helper';

import Demuxer from '../transmux/demux/demuxer';

import { Event } from '../events';

import { MediaFragmentState } from './media-fragment-tracker';
import { MediaFragment } from '../m3u8/media-fragment';

import { PlaylistLoadingHandler } from '../network/playlist-loading.handler';
import * as LevelHelper from '../m3u8/level-helper';

import { ErrorDetail } from '../errors';
import { logger } from '../utils/logger';
import { alignStream } from '../m3u8/discontinuities';

import { findFragmentByPTS, findFragmentByPDT } from '../m3u8/fragment-finders';
import { GapHandler } from './gap.handler';

import { TaskScheduler } from '../task-scheduler';
import { MediaVariantDetails, QualityLevel } from '../hls';
import { MediaFragmentReceiver, MediaSourceBufferMessage, MediaSourceBufferState } from './media-fragment-receiver';

const TICK_INTERVAL = 100; // how often to tick in ms

export class StreamSchedulingHandler extends TaskScheduler {

  private media: HTMLMediaElement;
  private mediaFragReceiver: MediaFragmentReceiver;
  private gapController: GapHandler = null;

  private _currentFragment: MediaFragment = null;
  private _previousFragment: MediaFragment;
  private _fragPlaying: MediaFragment = null;
  private _levels: QualityLevel[] = [];
  private _doingAudioCodecSwap: boolean = false;
  private _startPosition: number = 0;
  private _currentLevelIndex: number = -1;
  private _lastKnownMediaTime: number = null;
  private _startFragRequested: boolean = false;
  private _doingBandwidthTest: boolean = false;

  private _levelLastLoaded: number = null;
  private _altAudio: boolean = false;
  private _immediateSwitch: boolean;
  private _previouslyPaused: boolean;
  private _audioCodecSwitch: boolean;
  private _liveSyncPosition: number;
  private _fragmentLoadedPending: boolean = false;
  private _lastDownloadKbps: number;
  private _hasLoadedMetadata: boolean = false;

  private _onMediaSeeking: () => void;
  private _onMediaSeeked: () => void;
  private _onMediaEnded: () => void;

  constructor (hls, fragmentTracker) {
    super(hls,
      Event.MEDIA_ATTACHED,
      Event.MEDIA_DETACHING,
      Event.MANIFEST_LOADING,
      Event.MANIFEST_PARSED,
      Event.FRAG_LOADED,
      Event.LEVEL_LOADED,
      Event.KEY_LOADED,
      Event.ERROR
    );

    this._doingAudioCodecSwap = false;
    this.gapController = null;

    this.mediaFragReceiver = new MediaFragmentReceiver(this.hls);
    this.mediaFragReceiver.fragmentTracker = fragmentTracker;
  }

  get liveSyncPosition () {
    return this._liveSyncPosition;
  }

  set liveSyncPosition (value) {
    this._liveSyncPosition = value;
  }

  getCurrentLevelIndex (): number {
    let media = this.media;
    if (!media) {
      return -1;
    }
    const frag = this._trackBufferedFragment(media.currentTime);
    if (frag) {
      return frag.level;
    } else {
      return -1;
    }
  }

  getNextBufferedFragment (): MediaFragment {
    let media = this.media;
    if (!media) {
      return null;
    }
    // first get end range of current fragment
    return this._getFollowingBufferedFrag(this._trackBufferedFragment(media.currentTime));
  }

  onHandlerDestroying () {
    this.stopLoad();
    super.onHandlerDestroying();
  }

  onHandlerDestroyed () {
    this.mediaFragReceiver.fragmentTracker.destroy();
    this.mediaFragReceiver.fragmentTracker = null;
    super.onHandlerDestroyed();
  }

  startLoad (startPosition = -1) {
    if (!this._levels) {
      throw new Error('No levels')
    }

    const lastCurrentTime = this._lastKnownMediaTime;
    const hls = this.hls;

    this.stopLoad();
    this.setInterval(TICK_INTERVAL);

    this._currentLevelIndex = -1;
    if (!this._startFragRequested) {

      // determine load level
      let startLevel = hls.startLevel;
      if (startLevel === -1) {
        // -1 : guess start Level by doing a bitrate test by loading first fragment of lowest quality level
        startLevel = 0;
        this._doingBandwidthTest = true;
      }

      // set new level to playlist loader : this will trigger start level load
      // hls.nextLoadLevel remains until it is set to a new value or until a new frag is successfully loaded
      this._currentLevelIndex
        = hls.nextLoadLevel
        = startLevel;

    }

    // if startPosition undefined but lastCurrentTime set, set startPosition to last currentTime
    if (lastCurrentTime > 0 && startPosition === -1) {
      logger.log(`override startPosition with lastCurrentTime @${lastCurrentTime.toFixed(3)}`);
      startPosition = lastCurrentTime;
    }

    this._startPosition = this._lastKnownMediaTime = startPosition;

    this.tick();
  }

  stopLoad () {
    let frag = this._currentFragment;
    if (frag) {
      if (frag.loader) {
        frag.loader.abort();
      }

      this.mediaFragReceiver.fragmentTracker.removeFragment(frag);
      this._currentFragment = null;
    }
    this._previousFragment = null;

    this.clearInterval();
  }

  doTick () {
    this._doTick();
    this._checkBuffer();
    this._checkFragmentChanged();
  }

  /*
    on immediate level switch :
     - pause playback if playing
     - cancel any pending load request
     - and trigger a buffer flush
  */
  doImmediateLevelSwitch () {
    logger.log('immediateLevelSwitch');
    if (!this._immediateSwitch) {
      this._immediateSwitch = true;
      let media = this.media, previouslyPaused;
      if (media) {
        previouslyPaused = media.paused;
        media.pause();
      } else {
        // don't restart playback after instant level switch in case media not attached
        previouslyPaused = true;
      }
      this._previouslyPaused = previouslyPaused;
    }
    let fragCurrent = this._currentFragment;
    if (fragCurrent && fragCurrent.loader) {
      fragCurrent.loader.abort();
    }

    this._currentFragment = null;
    // flush everything
    this.mediaFragReceiver.flushMainBuffer(0, Number.POSITIVE_INFINITY);
  }

  /**
   * try to switch ASAP without breaking video playback:
   * in order to ensure smooth but quick level switching,
   * we need to find the next flushable buffer range
   * we should take into account new segment fetch time
   */
  doNextLevelSwitch () {
    const media = this.media;
    // ensure that media is defined and that metadata are available (to retrieve currentTime)
    if (media && media.readyState) {
      let fetchdelay, fragPlayingCurrent, nextBufferedFrag;
      fragPlayingCurrent = this._trackBufferedFragment(media.currentTime);
      if (fragPlayingCurrent && fragPlayingCurrent.startPTS > 1) {
        // flush buffer preceding current fragment (flush until current fragment start offset)
        // minus 1s to avoid video freezing, that could happen if we flush keyframe of current video ...
        this.mediaFragReceiver.flushMainBuffer(0, fragPlayingCurrent.startPTS - 1);
      }
      if (!media.paused) {
        // add a safety delay of 1s
        let nextLevelId = this.hls.nextLoadLevel, nextLevel = this._levels[nextLevelId], fragLastKbps = this._lastDownloadKbps;
        if (fragLastKbps && this._currentFragment) {
          fetchdelay = this._currentFragment.duration * nextLevel.bitrate / (1000 * fragLastKbps) + 1;
        } else {
          fetchdelay = 0;
        }
      } else {
        fetchdelay = 0;
      }
      // logger.log('fetchdelay:'+fetchdelay);
      // find buffer range that will be reached once new fragment will be fetched
      nextBufferedFrag = this._trackBufferedFragment(media.currentTime + fetchdelay);
      if (nextBufferedFrag) {
        // we can flush buffer range following this one without stalling playback
        nextBufferedFrag = this._getFollowingBufferedFrag(nextBufferedFrag);
        if (nextBufferedFrag) {
          // if we are here, we can also cancel any loading/demuxing in progress, as they are useless
          let fragCurrent = this._currentFragment;
          if (fragCurrent && fragCurrent.loader) {
            fragCurrent.loader.abort();
          }

          this._currentFragment = null;
          // start flush position is the start PTS of next buffered frag.
          // we use frag.naxStartPTS which is max(audio startPTS, video startPTS).
          // in case there is a small PTS Delta between audio and video, using maxStartPTS avoids flushing last samples from current fragment
          this.mediaFragReceiver.flushMainBuffer(nextBufferedFrag.maxStartPTS, Number.POSITIVE_INFINITY);
        }
      }
    }
  }

  swapAudioCodec () {
    this._doingAudioCodecSwap = !this._doingAudioCodecSwap;
  }

  onMediaAttached (data) {
    let media = this.media = this.mediaFragReceiver.mediaBuffer = data.media;
    this._onMediaSeeking = this.onMediaSeeking.bind(this);
    this._onMediaSeeked = this.onMediaSeeked.bind(this);
    this._onMediaEnded = this.onMediaEnded.bind(this);
    media.addEventListener('seeking', this._onMediaSeeking);
    media.addEventListener('seeked', this._onMediaSeeked);
    media.addEventListener('ended', this._onMediaEnded);
    let config = this.config;
    if (this._levels && config.autoStartLoad) {
      this.hls.startLoad(config.startPosition);
    }

    this.gapController = new GapHandler(config, media, this.mediaFragReceiver.fragmentTracker, this.hls);
  }

  onMediaDetaching () {
    let media = this.media;
    if (media && media.ended) {
      logger.log('MSE detaching and video ended, reset startPosition');
      this._startPosition = this._lastKnownMediaTime = 0;
    }

    // reset fragment backtracked flag
    let levels = this._levels;
    if (levels) {
      levels.forEach(level => {
        if (level.details) {
          level.details.fragments.forEach(fragment => {
            fragment.backtracked = undefined;
          });
        }
      });
    }
    // remove video listeners
    if (media) {
      media.removeEventListener('seeking', this._onMediaSeeking);
      media.removeEventListener('seeked', this._onMediaSeeked);
      media.removeEventListener('ended', this._onMediaEnded);
      this._onMediaSeeking = this._onMediaSeeked = this._onMediaEnded = null;
    }
    this.media = this.mediaFragReceiver.mediaBuffer = null;
    this.stopLoad();
  }

  onMediaSeeking () {
    let media = this.media, currentTime = media ? media.currentTime : undefined, config = this.config;
    if (Number.isFinite(currentTime)) {
      logger.log(`media seeking to ${currentTime.toFixed(3)}`);
    }

    let mediaBuffer = this.mediaFragReceiver.mediaBuffer ? this.mediaFragReceiver.mediaBuffer : media;
    let bufferInfo = BufferHelper.bufferInfo(mediaBuffer, currentTime, this.config.maxBufferHole);

    /// TODO: abort stuff
    /*
    if (this.mediaFragReceiver.state === State.FRAG_LOADING) {
      let fragCurrent = this.fragCurrent;
      // check if we are seeking to a unbuffered area AND if frag loading is in progress
      if (bufferInfo.len === 0 && fragCurrent) {
        let tolerance = config.maxFragLookUpTolerance,
          fragStartOffset = fragCurrent.start - tolerance,
          fragEndOffset = fragCurrent.start + fragCurrent.duration + tolerance;
        // check if we seek position will be out of currently loaded frag range : if out cancel frag load, if in, don't do anything
        if (currentTime < fragStartOffset || currentTime > fragEndOffset) {
          if (fragCurrent.loader) {
            logger.log('seeking outside of buffer while fragment load in progress, cancel fragment load');
            fragCurrent.loader.abort();
          }
          this.fragCurrent = null;
          this.fragPrevious = null;
          // switch to IDLE state to load new fragment
          this.mediaFragReceiver.state = State.IDLE;
        } else {
          logger.log('seeking outside of buffer but within currently loaded fragment range');
        }
      }
      */

    if (media) {
      this._lastKnownMediaTime = currentTime;
    }

    // tick to speed up processing
    this.tick();
  }

  onMediaSeeked () {
    const media = this.media, currentTime = media ? media.currentTime : undefined;
    if (Number.isFinite(currentTime)) {
      logger.log(`media seeked to ${currentTime.toFixed(3)}`);
    }

    // tick to speed up FRAGMENT_PLAYING triggering
    this.tick();
  }

  onMediaEnded () {
    logger.log('media ended');
    // reset startPosition and lastCurrentTime to restart playback @ stream beginning
    this._startPosition = this._lastKnownMediaTime = 0;
  }

  onManifestLoading () {
    // reset buffer on manifest loading
    logger.log('trigger BUFFER_RESET');
    this.hls.trigger(Event.BUFFER_RESET);
    this.mediaFragReceiver.fragmentTracker.removeAllFragments();
    this._startPosition = this._lastKnownMediaTime = 0;
  }

  onManifestParsed (data) {
    let aac = false, heaac = false, codec;
    data.levels.forEach(level => {
      // detect if we have different kind of audio codecs used amongst playlists
      codec = level.audioCodec;
      if (codec) {
        if (codec.indexOf('mp4a.40.2') !== -1) {
          aac = true;
        }

        if (codec.indexOf('mp4a.40.5') !== -1) {
          heaac = true;
        }
      }
    });
    this._audioCodecSwitch = (aac && heaac);
    if (this._audioCodecSwitch) {
      logger.log('both AAC/HE-AAC audio found in levels; declaring level codec as HE-AAC');
    }

    this._startFragRequested = false;
    this._levels = data.levels;

    this.mediaFragReceiver.setQualityLevels(this._levels);

    const config = this.config;
    if (config.autoStartLoad) {
      this.hls.startLoad(config.startPosition);
    }
  }

  onLevelLoaded (data) {
    const newDetails = data.details;
    const newLevelId = data.level;
    const lastLevel = this._levels[this._levelLastLoaded];
    const curLevel = this._levels[newLevelId];
    const duration = newDetails.totalduration;
    let sliding = 0;

    logger.log(`level ${newLevelId} loaded [${newDetails.startSN},${newDetails.endSN}], duration:${duration}`);

    if (newDetails.live) {
      let curDetails = curLevel.details;
      if (curDetails && newDetails.fragments.length > 0) {
        // we already have details for that level, merge them
        LevelHelper.mergeDetails(curDetails, newDetails);
        sliding = newDetails.fragments[0].start;
        this.liveSyncPosition = this._computeLivePosition(sliding, curDetails);
        if (newDetails.PTSKnown && Number.isFinite(sliding)) {
          logger.log(`live playlist sliding:${sliding.toFixed(3)}`);
        } else {
          logger.log('live playlist - outdated PTS, unknown sliding');
          alignStream(this._previousFragment, lastLevel, newDetails);
        }
      } else {
        logger.log('live playlist - first load, unknown sliding');
        newDetails.PTSKnown = false;
        alignStream(this._previousFragment, lastLevel, newDetails);
      }
    } else {
      newDetails.PTSKnown = false;
    }

    // override level info

    curLevel.details = newDetails;
    this._levelLastLoaded = newLevelId;

    this.hls.trigger(Event.LEVEL_UPDATED, { details: newDetails, level: newLevelId });

    if (!this._startFragRequested) {
      // compute start position if set to -1. use it straight away if value is defined
      if (this._startPosition === -1 || this._lastKnownMediaTime === -1) {
        // first, check if start time offset has been set in playlist, if yes, use this value
        let startTimeOffset = newDetails.startTimeOffset;
        if (Number.isFinite(startTimeOffset)) {
          if (startTimeOffset < 0) {
            logger.log(`negative start time offset ${startTimeOffset}, count from end of last fragment`);
            startTimeOffset = sliding + duration + startTimeOffset;
          }
          logger.log(`start time offset found in playlist, adjust startPosition to ${startTimeOffset}`);
          this._startPosition = startTimeOffset;
        } else {
          // if live playlist, set start position to be fragment N-this.config.liveSyncDurationCount (usually 3)
          if (newDetails.live) {
            this._startPosition = this._computeLivePosition(sliding, newDetails);
            logger.log(`configure startPosition to ${this._startPosition}`);
          } else {
            this._startPosition = 0;
          }
        }
        this._lastKnownMediaTime = this._startPosition;
      }

    }
    // only switch batck to IDLE state if we were waiting for level to start downloading a new fragment

    // trigger handler right now
    this.tick();
  }

  onKeyLoaded () {
    this.tick();
  }

  onFragLoaded () {
    this._fragmentLoadedPending = false;
  }

  onError (data) {
    let frag: MediaFragment = data.frag || this._currentFragment;
    // don't handle frag error not related to main fragment
    if (frag && frag.type !== 'main') {
      return;
    }

    // 0.5 : tolerance needed as some browsers stalls playback before reaching buffered end
    let mediaBuffered = !!this.media && BufferHelper.isBuffered(this.media, this.media.currentTime) && BufferHelper.isBuffered(this.media, this.media.currentTime + 0.5);

    switch (data.details) {
    case ErrorDetail.FRAG_LOAD_ERROR:
    case ErrorDetail.FRAG_LOAD_TIMEOUT:
    case ErrorDetail.KEY_LOAD_ERROR:
    case ErrorDetail.KEY_LOAD_TIMEOUT:
    case ErrorDetail.LEVEL_LOAD_ERROR:
    case ErrorDetail.LEVEL_LOAD_TIMEOUT:
      throw new Error('load error');
    case ErrorDetail.BUFFER_FULL_ERROR:

      if (mediaBuffered) {
        this._reduceMaxBufferLength(this.config.maxBufferLength);
      } else {
        // current position is not buffered, but browser is still complaining about buffer full error
        // this happens on IE/Edge, refer to https://github.com/video-dev/hls.js/pull/708
        // in that case flush the whole buffer to recover
        logger.warn('buffer full error also media.currentTime is not buffered, flush everything');
        this._currentFragment = null;
        // flush everything
        this.mediaFragReceiver.flushMainBuffer(0, Number.POSITIVE_INFINITY);
      }

      break;
    default:
      break;
    }
  }

  private _doTick () {
    if (this._fragmentLoadedPending) {
      return;
    }

    const hls = this.hls;
    const config = hls.config;
    const media = this.media;

    // if start level not parsed yet OR
    // if video not attached AND start fragment already requested OR start frag prefetch disable
    // exit loop, as we either need more info (level not parsed) or we need media to be attached to load new fragment
    if (this._levelLastLoaded === null || (
      !media && (this._startFragRequested || !config.startFragPrefetch))) {
      return;
    }

    // if we have not yet loaded any fragment, start loading from start position
    let pos;
    if (this._hasLoadedMetadata) {
      pos = media.currentTime;
    } else {
      pos = 0
    }

    // determine next load level
    const level = hls.nextLoadLevel;
    const levelInfo: QualityLevel = this._levels[level];

    logger.log('Loading level:', level);

    if (!levelInfo) {
      return;
    }

    let levelBitrate = levelInfo.bitrate;
    let maxBufLen;

    // compute max Buffer Length that we could get from this load level, based on level bitrate. don't buffer more than 60 MB and more than 30s
    if (levelBitrate) {
      maxBufLen = Math.max(8 * config.maxBufferSize / levelBitrate, config.maxBufferLength);
    } else {
      maxBufLen = config.maxBufferLength;
    }

    maxBufLen = Math.min(maxBufLen, config.maxMaxBufferLength);

    // determine next candidate fragment to be loaded, based on current position and end of buffer position
    // ensure up to `config.maxMaxBufferLength` of buffer upfront

    const bufferObject = this.mediaFragReceiver.mediaBuffer ? this.mediaFragReceiver.mediaBuffer : media;
    const bufferInfo = BufferHelper.bufferInfo(bufferObject, pos, config.maxBufferHole);
    const bufferLen = bufferInfo.len;
    // Stay idle if we are still with buffer margins
    if (bufferLen >= maxBufLen) {
      return;
    }

    // if buffer length is less than maxBufLen try to load a new fragment ...
    logger.trace(`buffer length of ${bufferLen.toFixed(3)} is below max of ${maxBufLen.toFixed(3)}. checking for more payload ...`);

    // set next load level : this will trigger a playlist load if needed
    // this.level = this.mediaFragReceiver.level = level;

    const levelDetails: MediaVariantDetails = levelInfo.details;
    if (!levelDetails) {
      return;
    }

    // we just got done loading the final fragment and there is no other buffered range after ...
    // rationale is that in case there are any buffered ranges after, it means that there are unbuffered portion in between
    // so we should not switch to ENDED in that case, to be able to buffer them
    // dont switch to ENDED if we need to backtrack last fragment
    const previousFragment = this._previousFragment;
    if (!levelDetails.live
      && previousFragment
      && !previousFragment.backtracked
      && previousFragment.sn === levelDetails.endSN
      && !bufferInfo.nextStart) {
      // fragPrevious is last fragment. retrieve level duration using last frag start offset + duration
      // real duration might be lower than initial duration if there are drifts between real frag duration and playlist signaling
      const duration = Math.min(media.duration, previousFragment.start + previousFragment.duration);
      // if everything (almost) til the end is buffered, let's signal eos
      // we don't compare exactly media.duration === bufferInfo.end as there could be some subtle media duration difference (audio/video offsets...)
      // tolerate up to one frag duration to cope with these cases.
      // also cope with almost zero last frag duration (max last frag duration with 200ms) refer to https://github.com/video-dev/hls.js/pull/657
      if (duration - Math.max(bufferInfo.end, previousFragment.start) <= Math.max(0.2, previousFragment.duration)) {

        // Finalize the media stream
        const data: MediaSourceBufferMessage = {
          type: null
        };

        if (this._altAudio) {
          data.type = 'video';
        }

        this.hls.trigger(Event.BUFFER_EOS, data);
        return;
      }
    }

    // if we have the levelDetails for the selected variant, lets continue enrichen our stream (load keys/fragments or trigger EOS, etc..)
    this._fetchPayloadOrEos(pos, bufferInfo, levelDetails);
  }

  private _fetchPayloadOrEos (pos, bufferInfo, levelDetails) {
    const fragPrevious = this._previousFragment,
      level = this._currentLevelIndex,
      fragments = levelDetails.fragments,
      fragLen = fragments.length;

    // empty playlist
    if (fragLen === 0) {
      return;
    }

    // find fragment index, contiguous with end of buffer position
    let start = fragments[0].start,
      end = fragments[fragLen - 1].start + fragments[fragLen - 1].duration,
      bufferEnd = bufferInfo.end,
      frag;

    if (levelDetails.initSegment && !levelDetails.initSegment.data) {
      frag = levelDetails.initSegment;
    } else {
      // in case of live playlist we need to ensure that requested position is not located before playlist start
      if (levelDetails.live) {
        let initialLiveManifestSize = this.config.initialLiveManifestSize;
        if (fragLen < initialLiveManifestSize) {
          logger.warn(`Can not start playback of a level, reason: not enough fragments ${fragLen} < ${initialLiveManifestSize}`);
          return;
        }

        frag = this._ensureFragmentAtLivePoint(levelDetails, bufferEnd, start, end, fragPrevious, fragments, fragLen);
        // if it explicitely returns null don't load any fragment and exit function now
        if (frag === null) {
          return;
        }
      } else {
        // VoD playlist: if bufferEnd before start of playlist, load first fragment
        if (bufferEnd < start) {
          frag = fragments[0];
        }
      }
    }
    if (!frag) {
      frag = this._findFragment(start, fragPrevious, fragLen, fragments, bufferEnd, end, levelDetails);
    }

    if (frag) {
      if (frag.encrypted) {
        logger.log(`Loading key for ${frag.sn} of [${levelDetails.startSN} ,${levelDetails.endSN}], level ${level}`);
        this._loadKey(frag);
      } else {
        logger.log(`Loading ${frag.sn} of [${levelDetails.startSN}, ${levelDetails.endSN}], level ${level}, currentTime: ${pos.toFixed(3)}, bufferEnd: ${bufferEnd.toFixed(3)}`);
        this._loadFragment(frag);
      }
    }
  }

  private _ensureFragmentAtLivePoint (levelDetails: MediaVariantDetails, bufferEnd, start, end, fragPrevious, fragments, fragLen) {
    const config = this.hls.config, media = this.media;

    let frag;

    // check if requested position is within seekable boundaries :
    // logger.log(`start/pos/bufEnd/seeking:${start.toFixed(3)}/${pos.toFixed(3)}/${bufferEnd.toFixed(3)}/${this.media.seeking}`);
    let maxLatency = config.liveMaxLatencyDuration !== undefined ? config.liveMaxLatencyDuration : config.liveMaxLatencyDurationCount * levelDetails.targetduration;

    if (bufferEnd < Math.max(start - config.maxFragLookUpTolerance, end - maxLatency)) {
      let liveSyncPosition = this.liveSyncPosition = this._computeLivePosition(start, levelDetails);
      logger.log(`buffer end: ${bufferEnd.toFixed(3)} is located too far from the end of live sliding playlist, reset currentTime to : ${liveSyncPosition.toFixed(3)}`);
      bufferEnd = liveSyncPosition;
      if (media && media.readyState && media.duration > liveSyncPosition) {
        media.currentTime = liveSyncPosition;
      }

    }

    // if end of buffer greater than live edge, don't load any fragment
    // this could happen if live playlist intermittently slides in the past:
    // level 1 loaded [182580161,182580167]
    // level 1 loaded [182580162,182580169]
    // Loading 182580168 of [182580162 ,182580169],level 1 ..
    // Loading 182580169 of [182580162 ,182580169],level 1 ..
    // level 1 loaded [182580162,182580168] <============= here we should have bufferEnd > end. in that case break to avoid reloading 182580168
    // level 1 loaded [182580164,182580171]
    //
    // don't return null in case media not loaded yet (readystate === 0)
    if (levelDetails.PTSKnown && bufferEnd > end && media && media.readyState) {
      return null;
    }

    if (this._startFragRequested && !levelDetails.PTSKnown) {
      /* we are switching level on live playlist, but we don't have any PTS info for that quality level ...
         try to load frag matching with next SN.
         even if SN are not synchronized between playlists, loading this frag will help us
         compute playlist sliding and find the right one after in case it was not the right consecutive one */
      if (fragPrevious) {
        if (levelDetails.hasProgramDateTime) {
          // Relies on PDT in order to switch bitrates (Support EXT-X-DISCONTINUITY without EXT-X-DISCONTINUITY-SEQUENCE)
          logger.log(`live playlist, switching playlist, load frag with same PDT: ${fragPrevious.programDateTime}`);
          frag = findFragmentByPDT(fragments, fragPrevious.endProgramDateTime, config.maxFragLookUpTolerance);
        } else {
          // Uses buffer and sequence number to calculate switch segment (required if using EXT-X-DISCONTINUITY-SEQUENCE)
          const targetSN = fragPrevious.sn + 1;
          if (targetSN >= levelDetails.startSN && targetSN <= levelDetails.endSN) {
            const fragNext = fragments[targetSN - levelDetails.startSN];
            if (fragPrevious.cc === fragNext.cc) {
              frag = fragNext;
              logger.log(`live playlist, switching playlist, load frag with next SN: ${frag.sn}`);
            }
          }
          // next frag SN not available (or not with same continuity counter)
          // look for a frag sharing the same CC
          if (!frag) {
            frag = BinarySearch.search(fragments, function (frag) {
              return fragPrevious.cc - frag.cc;
            });
            if (frag) {
              logger.log(`live playlist, switching playlist, load frag with same CC: ${frag.sn}`);
            }
          }
        }
      }
      if (!frag) {
        /* we have no idea about which fragment should be loaded.
           so let's load mid fragment. it will help computing playlist sliding and find the right one
        */
        frag = fragments[Math.min(fragLen - 1, Math.round(fragLen / 2))];
        logger.log(`live playlist, switching playlist, unknown, load middle frag : ${frag.sn}`);
      }
    }

    return frag;
  }

  private _findFragment (start, fragPrevious, fragLen, fragments, bufferEnd, end, levelDetails) {
    const config = this.hls.config;
    let frag;

    if (bufferEnd < end) {
      const lookupTolerance = (bufferEnd > end - config.maxFragLookUpTolerance) ? 0 : config.maxFragLookUpTolerance;
      // Remove the tolerance if it would put the bufferEnd past the actual end of stream
      // Uses buffer and sequence number to calculate switch segment (required if using EXT-X-DISCONTINUITY-SEQUENCE)
      frag = findFragmentByPTS(fragPrevious, fragments, bufferEnd, lookupTolerance);
    } else {
      // reach end of playlist
      frag = fragments[fragLen - 1];
    }
    if (frag) {
      const curSNIdx = frag.sn - levelDetails.startSN;
      const sameLevel = fragPrevious && frag.level === fragPrevious.level;
      const prevFrag = fragments[curSNIdx - 1];
      const nextFrag = fragments[curSNIdx + 1];
      // logger.log('find SN matching with pos:' +  bufferEnd + ':' + frag.sn);
      if (fragPrevious && frag.sn === fragPrevious.sn) {
        if (sameLevel && !frag.backtracked) {
          if (frag.sn < levelDetails.endSN) {
            let deltaPTS = fragPrevious.deltaPTS;
            // if there is a significant delta between audio and video, larger than max allowed hole,
            // and if previous remuxed fragment did not start with a keyframe. (fragPrevious.dropped)
            // let's try to load previous fragment again to get last keyframe
            // then we will reload again current fragment (that way we should be able to fill the buffer hole ...)
            if (deltaPTS && deltaPTS > config.maxBufferHole && fragPrevious.dropped && curSNIdx) {
              frag = prevFrag;
              logger.warn('SN just loaded, with large PTS gap between audio and video, maybe frag is not starting with a keyframe ? load previous one to try to overcome this');
            } else {
              frag = nextFrag;
              logger.log(`SN just loaded, load next one: ${frag.sn}`, frag);
            }
          } else {
            frag = null;
          }
        } else if (frag.backtracked) {
          // Only backtrack a max of 1 consecutive fragment to prevent sliding back too far when little or no frags start with keyframes
          if (nextFrag && nextFrag.backtracked) {
            logger.warn(`Already backtracked from fragment ${nextFrag.sn}, will not backtrack to fragment ${frag.sn}. Loading fragment ${nextFrag.sn}`);
            frag = nextFrag;
          } else {
            // If a fragment has dropped frames and it's in a same level/sequence, load the previous fragment to try and find the keyframe
            // Reset the dropped count now since it won't be reset until we parse the fragment again, which prevents infinite backtracking on the same segment
            logger.warn('Loaded fragment with dropped frames, backtracking 1 segment to find a keyframe');
            frag.dropped = 0;
            if (prevFrag) {
              frag = prevFrag;
              frag.backtracked = true;
            } else if (curSNIdx) {
              // can't backtrack on very first fragment
              frag = null;
            }
          }
        }
      }
    }
    return frag;
  }

  private _loadKey (frag) {
    this.hls.trigger(Event.KEY_LOADING, { frag });
  }

  private _loadFragment (frag) {
    // Check if fragment is not loaded
    let fragState = this.mediaFragReceiver.fragmentTracker.getState(frag);

    this._currentFragment = frag;
    this._startFragRequested = true;

    // Allow backtracked fragments to load
    if (frag.backtracked ||
        fragState === MediaFragmentState.NOT_LOADED ||
        fragState === MediaFragmentState.PARTIAL) {
      frag.autoLevel = this.hls.autoLevelEnabled;
      frag.bitrateTest = this._doingBandwidthTest;

      this._fragmentLoadedPending = true;
      this.hls.trigger(Event.FRAG_LOADING, { frag });

    } else if (fragState === MediaFragmentState.APPENDING) {
      // Lower the buffer size and try again
      if (this._reduceMaxBufferLength(frag.duration)) {
        this.mediaFragReceiver.fragmentTracker.removeFragment(frag);
      }
    }
  }

  private _trackBufferedFragment (position): MediaFragment {
    return this.mediaFragReceiver.fragmentTracker
      .getBufferedFrag(position, PlaylistLoadingHandler.LevelType.MAIN);
  }

  private _getFollowingBufferedFrag (frag) {
    if (frag) {
      // try to get range of next fragment (500ms after this range)
      return this._trackBufferedFragment(frag.endPTS + 0.5);
    }
    return null;
  }

  private _checkFragmentChanged () {
    let fragPlayingCurrent, currentTime, video = this.media;
    if (video && video.readyState && video.seeking === false) {
      currentTime = video.currentTime;
      /* if video element is in seeked state, currentTime can only increase.
        (assuming that playback rate is positive ...)
        As sometimes currentTime jumps back to zero after a
        media decode error, check this, to avoid seeking back to
        wrong position after a media decode error
      */
      if (currentTime > this._lastKnownMediaTime) {
        this._lastKnownMediaTime = currentTime;
      }

      if (BufferHelper.isBuffered(video, currentTime)) {
        fragPlayingCurrent = this._trackBufferedFragment(currentTime);
      } else if (BufferHelper.isBuffered(video, currentTime + 0.1)) {
        /* ensure that FRAG_CHANGED event is triggered at startup,
          when first video frame is displayed and playback is paused.
          add a tolerance of 100ms, in case current position is not buffered,
          check if current pos+100ms is buffered and use that buffer range
          for FRAG_CHANGED event reporting */
        fragPlayingCurrent = this._trackBufferedFragment(currentTime + 0.1);
      }
      if (fragPlayingCurrent) {
        let fragPlaying = fragPlayingCurrent;
        if (fragPlaying !== this._fragPlaying) {
          this.hls.trigger(Event.FRAG_CHANGED, { frag: fragPlaying });
          const fragPlayingLevel = fragPlaying.level;
          if (!this._fragPlaying || this._fragPlaying.level !== fragPlayingLevel) {
            this.hls.trigger(Event.LEVEL_SWITCHED, { level: fragPlayingLevel });
          }

          this._fragPlaying = fragPlaying;
        }
      }
    }
  }

  /**
   * on immediate level switch end, after new fragment has been buffered:
   * - nudge video decoder by slightly adjusting video currentTime (if currentTime buffered)
   * - resume the playback if needed
   */
  private _onImmediateLevelSwitchEnd () {
    const media = this.media;
    if (media && media.buffered.length) {
      this._immediateSwitch = false;
      if (BufferHelper.isBuffered(media, media.currentTime)) {
        // only nudge if currentTime is buffered
        media.currentTime -= 0.0001;
      }
      if (!this._previouslyPaused) {
        media.play();
      }
    }
  }

  private _reduceMaxBufferLength (minLength) {
    let config = this.config;
    if (config.maxMaxBufferLength >= minLength) {
      // reduce max buffer length as it might be too high. we do this to avoid loop flushing ...
      config.maxMaxBufferLength /= 2;
      logger.warn(`main:reduce max buffer length to ${config.maxMaxBufferLength}s`);
      return true;
    }
    return false;
  }

  private _computeLivePosition (sliding, levelDetails) {
    let targetLatency = this.config.liveSyncDuration !== undefined ? this.config.liveSyncDuration : this.config.liveSyncDurationCount * levelDetails.targetduration;
    return sliding + Math.max(0, levelDetails.totalduration - targetLatency);
  }

  /**
   * Checks the health of the buffer and attempts to resolve playback stalls.
   * @private
   */
  private _checkBuffer () {
    const { media } = this;
    if (!media || media.readyState === 0) {
      // Exit early if we don't have media or if the media hasn't bufferd anything yet (readyState 0)
      return;
    }

    const mediaBuffer = this.mediaFragReceiver.mediaBuffer ? this.mediaFragReceiver.mediaBuffer : media;
    const buffered = mediaBuffer.buffered;

    if (buffered.length) {
      //this._seekToStartPos();
    } else if (this._immediateSwitch) {
      this._onImmediateLevelSwitchEnd();
    } else {
      this.gapController.poll(this._lastKnownMediaTime, buffered);
    }
  }
}
