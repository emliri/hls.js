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

  private _requestedFragment: MediaFragment = null;
  private _previousFragment: MediaFragment;
  private _fragPlaying: MediaFragment = null;
  private _levels: QualityLevel[] = [];

  private _currentLevelIndex: number = -1;
  private _lastKnownMediaTime: number = null;
  private _liveSyncPosition: number = null;
  private _lastDownloadKbps: number = null;

  private _altAudio: boolean = false;
  private _immediateSwitch: boolean = false;
  private _previouslyPaused: boolean = false;
  private _fragmentLoadedPending: boolean = false;

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
    this.stop();
    super.onHandlerDestroying();
  }

  onHandlerDestroyed () {
    this.mediaFragReceiver.fragmentTracker.destroy();
    this.mediaFragReceiver.fragmentTracker = null;
    super.onHandlerDestroyed();
  }

  start (startPosition = -1) {
    if (!this._levels) {
      throw new Error('No levels')
    }

    const lastCurrentTime = this._lastKnownMediaTime;
    const hls = this.hls;

    this.stop();
    this.setInterval(TICK_INTERVAL);

    this._currentLevelIndex = -1;
    if (!this._fragmentLoadedPending) {

      // determine load level
      let startLevel = hls.startLevel;
      if (startLevel === -1) {
        // -1 : guess start Level by doing a bitrate test by loading first fragment of lowest quality level
        startLevel = 0;
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

    this._lastKnownMediaTime = startPosition;

    this.tick();
  }

  stop () {
    let frag = this._requestedFragment;
    if (frag) {
      if (frag.loader) {
        frag.loader.abort();
      }

      this.mediaFragReceiver.fragmentTracker.removeFragment(frag);
      this._requestedFragment = null;
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
    let fragCurrent = this._requestedFragment;
    if (fragCurrent && fragCurrent.loader) {
      fragCurrent.loader.abort();
    }

    this._requestedFragment = null;
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
    if (!media || !media.readyState) {
      return;
    }

    let fetchLatencySeconds: number;
    let fragPlayingCurrent: MediaFragment = this._trackBufferedFragment(media.currentTime);
    let nextBufferedFrag: MediaFragment;

    if (fragPlayingCurrent && fragPlayingCurrent.startPTS > 1) {
      // flush buffer preceding current fragment (flush until current fragment start offset)
      // minus 1s to avoid video freezing, that could happen if we flush keyframe of current video ...
      this.mediaFragReceiver.flushMainBuffer(0, fragPlayingCurrent.startPTS - 1);
    }
    if (!media.paused) {

      let nextLevelId = this.hls.nextLoadLevel,
          nextLevel = this._levels[nextLevelId],
          fragLastKbps = this._lastDownloadKbps;

      if (fragLastKbps && this._requestedFragment) {
        // we compute the latency from now for the next fetch
        // so we know what we can flush from current buffer
        // we add a safety delay of 1s
        fetchLatencySeconds = this._requestedFragment.duration * nextLevel.bitrate / (1000 * fragLastKbps) + 1;
      } else {
        fetchLatencySeconds = 0;
      }
    } else {
      fetchLatencySeconds = 0;
    }
    // logger.log('fetchdelay:'+fetchdelay);
    // find buffer range that will be reached once new fragment will be fetched
    nextBufferedFrag = this._trackBufferedFragment(media.currentTime + fetchLatencySeconds);
    if (nextBufferedFrag) {
      // we can flush buffer range following this one without stalling playback
      nextBufferedFrag = this._getFollowingBufferedFrag(nextBufferedFrag);
      if (nextBufferedFrag) {
        // if we are here, we can also cancel any loading/demuxing in progress, as they are useless
        let fragCurrent = this._requestedFragment;
        if (fragCurrent && fragCurrent.loader) {
          fragCurrent.loader.abort();
        }

        this._requestedFragment = null;
        // start flush position is the start PTS of next buffered frag.
        // we use frag.naxStartPTS which is max(audio startPTS, video startPTS).
        // in case there is a small PTS Delta between audio and video, using maxStartPTS avoids flushing last samples from current fragment
        this.mediaFragReceiver.flushMainBuffer(nextBufferedFrag.maxStartPTS, Number.POSITIVE_INFINITY);
      }
    }
  }

  onMediaAttached (data) {
    // use MediaObserver class
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
      this._lastKnownMediaTime = 0;
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
    this.stop();
  }

  onMediaSeeking () {
    let media = this.media, currentTime = media ? media.currentTime : undefined, config = this.config;
    if (Number.isFinite(currentTime)) {
      logger.log(`media seeking to ${currentTime.toFixed(3)}`);
    }

    if (media) {
      this._lastKnownMediaTime = currentTime;
    }

    // tick to speed up processing
    this.tick();

    /// TODO: abort stuff
    /*
    let mediaBuffer = this.mediaFragReceiver.mediaBuffer ? this.mediaFragReceiver.mediaBuffer : media;
    let bufferInfo = BufferHelper.bufferInfo(mediaBuffer, currentTime, this.config.maxBufferHole);
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
  }

  onMediaSeeked () {
    const media = this.media, currentTime = media ? media.currentTime : undefined;
    if (Number.isFinite(currentTime)) {
      logger.log(`media seeked to ${currentTime.toFixed(3)}`);
    }
    this.tick();
  }

  onMediaEnded () {
    logger.log('media ended');
    // reset startPosition and lastCurrentTime to restart playback @ stream beginning
    this._lastKnownMediaTime = 0;
  }

  onManifestLoading () {
    // reset buffer on manifest loading
    logger.log('trigger BUFFER_RESET');
    this.hls.trigger(Event.BUFFER_RESET);
    this.mediaFragReceiver.fragmentTracker.removeAllFragments();
    this._lastKnownMediaTime = 0;
  }

  onManifestParsed (data) {

    // TODO: handle audio codec switch in buffer handler
    /*
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
    */

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
    const duration = newDetails.totalduration;

    // update QualityLevel info
    this._levels[newLevelId].details = newDetails;


    logger.log(`level ${newLevelId} loaded [${newDetails.startSN},${newDetails.endSN}], duration:${duration}`);

    this.hls.trigger(Event.LEVEL_UPDATED, { details: newDetails, level: newLevelId });

    this.tick();

    // handle live playlist sliding elsewhere
    /*
        let sliding = 0;
        const lastLevel = this._levels[this._levelLastLoaded];
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
    */
  }

  onKeyLoaded () {
    this.tick();
  }

  onFragLoaded () {
    this._fragmentLoadedPending = false;
  }

  onError (data) {
    let frag: MediaFragment = data.frag || this._requestedFragment;
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
        this._requestedFragment = null;
        // flush everything
        this.mediaFragReceiver.flushMainBuffer(0, Number.POSITIVE_INFINITY);
      }

      break;
    default:
      break;
    }
  }

  private _doTick () {
    if (!this.media) {
      return;
    }

    if (this._fragmentLoadedPending) {
      return;
    }

    const hls = this.hls;
    const config = hls.config;
    const media = this.media;
    const mediaPosition = media.currentTime;
    const levelIndex = hls.nextLoadLevel;
    const levelInfo: QualityLevel = this._levels[levelIndex];
    const levelBitrate = levelInfo.bitrate;

    let maxBufLen;

    if (!levelInfo) {
      return;
    }
    logger.log('Streaming media variant with quality-level index:', levelIndex);

    // compute max buffer length that we could get from this load level,
    // based on level bitrate. Don't buffer more than 60 MB and more than 30s.
    if (levelBitrate) {
      maxBufLen = Math.max(8 * config.maxBufferSize / levelBitrate, config.maxBufferLength);
    } else {
      maxBufLen = config.maxBufferLength;
    }
    maxBufLen = Math.min(maxBufLen, config.maxMaxBufferLength);

    // determine next candidate fragment to be loaded, based on current position and end of buffer position
    // ensure up to `config.maxMaxBufferLength` of buffer upfront
    const bufferObject = this.mediaFragReceiver.mediaBuffer ? this.mediaFragReceiver.mediaBuffer : media;
    const bufferInfo = BufferHelper.bufferInfo(bufferObject, mediaPosition, config.maxBufferHole);
    const bufferLen = bufferInfo.len;

    // Stay idle if we are still withing buffer margins
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

    this._tryHandleEos(levelDetails, bufferInfo);

    // if we have the levelDetails for the selected variant, lets continue enrichen our stream (load keys/fragments or trigger EOS, etc..)
    this._pollNextFragmentLoad(bufferInfo, levelDetails);
  }

  private _tryHandleEos(levelDetails: MediaVariantDetails, bufferInfo) {
    const media = this.media;
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
  }

  private _pollNextFragmentLoad (bufferInfo, variantDetails) {
    const previousFragment: MediaFragment = this._previousFragment;
    const currentLevelIndex: number = this._currentLevelIndex;
    const variantFragments: MediaFragment[] = variantDetails.fragments;
    const variantLength: number = variantFragments.length;

    // empty playlist
    if (variantLength === 0) {
      return;
    }

    // find fragment index, contiguous with end of buffer position

    // put into quality-level methods
    const streamStartTime = variantFragments[0].start;
    const streamEndTime = variantFragments[variantLength - 1].start
        + variantFragments[variantLength - 1].duration;
    const bufferEnd: number = bufferInfo.end;
    let nextFragmentLoaded: MediaFragment;

    // FIXME: make QualityLevel method
    if (variantDetails.initSegment && !variantDetails.initSegment.data) {
      nextFragmentLoaded = variantDetails.initSegment;
      return;
    }

    if (variantDetails.live) {

      let initialLiveManifestSize = this.config.initialLiveManifestSize;
      if (variantLength < initialLiveManifestSize) {
        logger.warn(`Can not start playback of a level, reason: not enough fragments ${variantLength} < ${initialLiveManifestSize}`);
        return;
      }

      nextFragmentLoaded = this._checkForFragmentAtLivePoint(
        variantDetails,
        bufferEnd,
        streamStartTime,
        streamEndTime,
        previousFragment,
        variantFragments
      )

      // in case of live playlist we need to ensure that requested position is not located before playlist start
      if (!nextFragmentLoaded) {
        return;
      }

    } else {
      // VoD playlist: if bufferEnd before start of playlist, load first fragment
      if (bufferEnd < streamStartTime) {
        nextFragmentLoaded = variantFragments[0];
      }
    }

    if (!nextFragmentLoaded) {
      nextFragmentLoaded = this._findFragment(
        streamStartTime,
        previousFragment,
        variantLength,
        variantFragments,
        bufferEnd,
        streamEndTime,
        variantDetails);
    }

    if (!nextFragmentLoaded) {
      logger.warn('No next fragment to load found');
    }

    if (nextFragmentLoaded.encrypted) {
      logger.log(`Loading key for ${nextFragmentLoaded.sn} of [${variantDetails.startSN} ,${variantDetails.endSN}], variant-idx ${currentLevelIndex}`);
      this._fetchMediaKey(nextFragmentLoaded);
      return;
    }

    // Load fragment!
    logger.log(`Loading ${nextFragmentLoaded.sn} of [${variantDetails.startSN}, ${variantDetails.endSN}], variant-idx ${currentLevelIndex}, buffer-end is at: ${bufferEnd.toFixed(3)}`);
    this._fetchMediaFragment(nextFragmentLoaded);

  }

  private _checkForFragmentAtLivePoint (
    variantDetails: MediaVariantDetails,
    bufferEnd: number,
    streamStart: number,
    streamEnd: number,
    previousFragment: MediaFragment,
    variantFragments) {

    const config = this.hls.config;
    const media = this.media;
    const variantLength = variantFragments.length;

    let mediaFragmentLookup: MediaFragment;

    // Get max latency from config or use default factor of target-duration in variant
    let maxLatency =
      config.liveMaxLatencyDuration !== undefined ?
        config.liveMaxLatencyDuration : (config.liveMaxLatencyDurationCount * variantDetails.targetduration);

    // check if it's in seekable boundaries
    if (bufferEnd < Math.max(streamStart - config.maxFragLookUpTolerance, streamEnd - maxLatency)) {
      let liveSyncPosition = this.liveSyncPosition = this._computeLivePosition(streamStart, variantDetails);
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
    if (variantDetails.isPtsKnown && bufferEnd > streamEnd && media && media.readyState) {
      return null;
    }

    if (!variantDetails.isPtsKnown) {
      /* we are switching level on live playlist, but we don't have any PTS info for that quality level ...
         try to load frag matching with next SN.
         even if SN are not synchronized between playlists, loading this frag will help us
         compute playlist sliding and find the right one after in case it was not the right consecutive one */
      if (previousFragment) {
        if (variantDetails.hasProgramDateTime) {
          // Relies on PDT in order to switch bitrates (Support EXT-X-DISCONTINUITY without EXT-X-DISCONTINUITY-SEQUENCE)
          logger.log(`live playlist, switching playlist, load frag with same PDT: ${previousFragment.programDateTime}`);
          mediaFragmentLookup = findFragmentByPDT(variantFragments, previousFragment.endProgramDateTime, config.maxFragLookUpTolerance);
        } else {
          // Uses buffer and sequence number to calculate switch segment (required if using EXT-X-DISCONTINUITY-SEQUENCE)
          const targetSN = previousFragment.sn + 1;
          if (targetSN >= variantDetails.startSN && targetSN <= variantDetails.endSN) {
            const fragNext = variantFragments[targetSN - variantDetails.startSN];
            if (previousFragment.cc === fragNext.cc) {
              mediaFragmentLookup = fragNext;
              logger.log(`live playlist, switching playlist, load frag with next SN: ${mediaFragmentLookup.sn}`);
            }
          }
          // next frag SN not available (or not with same continuity counter)
          // look for a frag sharing the same CC
          if (!mediaFragmentLookup) {
            mediaFragmentLookup = BinarySearch.search(variantFragments, function (frag) {
              return previousFragment.cc - frag.cc;
            });
            if (mediaFragmentLookup) {
              logger.log(`live playlist, switching playlist, load frag with same CC: ${mediaFragmentLookup.sn}`);
            }
          }
        }
      }
      if (!mediaFragmentLookup) {
        /* we have no idea about which fragment should be loaded.
           so let's load mid fragment. it will help computing playlist sliding and find the right one
        */
        mediaFragmentLookup = variantFragments[Math.min(variantLength - 1, Math.round(variantLength / 2))];
        logger.log(`live playlist, switching playlist, unknown, load middle frag : ${mediaFragmentLookup.sn}`);
      }
    }

    return mediaFragmentLookup;
  }

  private _findFragment (start, fragPrevious, fragLen, fragments, bufferEnd, end, levelDetails): MediaFragment {
    const config = this.hls.config;

    let mediaFragment: MediaFragment = null;

    if (bufferEnd < end) {
      const lookupTolerance = (bufferEnd > end - config.maxFragLookUpTolerance) ? 0 : config.maxFragLookUpTolerance;
      // Remove the tolerance if it would put the bufferEnd past the actual end of stream
      // Uses buffer and sequence number to calculate switch segment (required if using EXT-X-DISCONTINUITY-SEQUENCE)
      mediaFragment = findFragmentByPTS(fragPrevious, fragments, bufferEnd, lookupTolerance);
    } else {
      // reached end of playlist
      mediaFragment = fragments[fragLen - 1];
    }

    if (!mediaFragment) {
      return null;
    }

    // more live handling that should be somewhere else
    /*
    const sequenceNoBasedRelFragmentIdx = mediaFragment.sn - levelDetails.startSN;
    const isSameVariant = fragPrevious && mediaFragment.level === fragPrevious.level;
    const previousFragment = fragments[sequenceNoBasedRelFragmentIdx - 1];
    const nextFragment = fragments[sequenceNoBasedRelFragmentIdx + 1];

    if (previousFragment && mediaFragment.sn === fragPrevious.sn) {
      if (isSameVariant && !mediaFragment.backtracked) {
        if (mediaFragment.sn < levelDetails.endSN) {
          let deltaPTS = fragPrevious.deltaPTS;
          // if there is a significant delta between audio and video, larger than max allowed hole,
          // and if previous remuxed fragment did not start with a keyframe. (fragPrevious.dropped)
          // let's try to load previous fragment again to get last keyframe
          // then we will reload again current fragment (that way we should be able to fill the buffer hole ...)
          if (deltaPTS && deltaPTS > config.maxBufferHole && fragPrevious.dropped && sequenceNoBasedRelFragmentIdx) {
            mediaFragment = previousFragment;
            logger.warn('SN just loaded, with large PTS gap between audio and video, maybe frag is not starting with a keyframe ? load previous one to try to overcome this');
          } else {
            mediaFragment = nextFragment;
            logger.log(`SN just loaded, load next one: ${mediaFragment.sn}`, mediaFragment);
          }
        } else {
          mediaFragment = null;
        }
      } else if (mediaFragment.backtracked) {
        // Only backtrack a max of 1 consecutive fragment to prevent sliding back too far when little or no frags start with keyframes
        if (nextFragment && nextFragment.backtracked) {
          logger.warn(`Already backtracked from fragment ${nextFragment.sn}, will not backtrack to fragment ${mediaFragment.sn}. Loading fragment ${nextFragment.sn}`);
          mediaFragment = nextFragment;
        } else {
          // If a fragment has dropped frames and it's in a same level/sequence, load the previous fragment to try and find the keyframe
          // Reset the dropped count now since it won't be reset until we parse the fragment again, which prevents infinite backtracking on the same segment
          logger.warn('Loaded fragment with dropped frames, backtracking 1 segment to find a keyframe');
          mediaFragment.framesDropped = 0;
          if (previousFragment) {
            mediaFragment = previousFragment;
            mediaFragment.backtracked = true;
          } else if (sequenceNoBasedRelFragmentIdx) {
            // can't backtrack on very first fragment
            mediaFragment = null;
          }
        }
      }
    }
    */

    return mediaFragment;
  }

  private _fetchMediaKey (frag) {
    this.hls.trigger(Event.KEY_LOADING, { frag });
  }

  private _fetchMediaFragment (mediaFragment: MediaFragment) {

    this._requestedFragment = mediaFragment;

    // Allow backtracked fragments to load

    // Check if fragment is not loaded
    let fragmentState = this.mediaFragReceiver.fragmentTracker.getState(mediaFragment);

    if (mediaFragment.backtracked ||
        fragmentState === MediaFragmentState.NOT_LOADED ||
        fragmentState === MediaFragmentState.PARTIAL) {

      this._fragmentLoadedPending = true;
      this.hls.trigger(Event.FRAG_LOADING, { frag: mediaFragment });

    } else if (fragmentState === MediaFragmentState.APPENDING) {
      // Lower the buffer size and try again
      if (this._reduceMaxBufferLength(mediaFragment.duration)) {
        this.mediaFragReceiver.fragmentTracker.removeFragment(mediaFragment);
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
