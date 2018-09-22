import { EventHandler } from '../event-handler';
import { MediaFragment } from '../m3u8/media-fragment';
import { logger } from '../utils/logger';
import { Event } from '../events';
import TimeRanges from '../media-source-api/time-ranges';
import * as LevelHelper from '../m3u8/level-helper';

import Hls, { QualityLevel } from '../hls';
import Demuxer from '../transmux/demux/demuxer';
import { MediaFragmentTracker } from './media-fragment-tracker';

export type MediaSourceBufferMessage = {
  type: 'video'
  startOffset?: number,
  endOffset?: number
};

export type MediaSourceBufferState = {
  buffered: TimeRanges;
};

export class MediaFragmentReceiver extends EventHandler {

  videoBuffer: any; // FIXME
  mediaBuffer: any;

  fragmentTracker: MediaFragmentTracker;

  private _media: HTMLMediaElement;
  private _levels: QualityLevel[];
  private _fragLoaded: MediaFragment;
  private _demuxer: Demuxer;
  private _stats: any;
  private _audioCodecSwap: boolean;
  private _audioCodecSwitch: boolean;
  private _currentLevelIndex: number = 0;
  private _pendingBuffering: boolean;
  private _altAudio: boolean;
  private _appended: boolean;

  constructor (hls: Hls) {
    super(hls,
      Event.FRAG_LOADING,
      Event.FRAG_LOADED,
      Event.FRAG_LOAD_EMERGENCY_ABORTED,
      Event.FRAG_PARSING_INIT_SEGMENT,
      Event.FRAG_PARSING_DATA,
      Event.FRAG_PARSED,
      Event.BUFFER_CREATED,
      Event.BUFFER_APPENDED,
      Event.BUFFER_FLUSHED
    );

  }

  setQualityLevels(levels: QualityLevel[]) {
    this._levels = levels;
  }

  flushMainBuffer (startOffset, endOffset) {
    let flushScopeMessage: MediaSourceBufferMessage = {
      startOffset,
      endOffset,
      type: null
    };
    // if alternate audio tracks are used, only flush video, otherwise flush everything
    if (this._altAudio) {
      flushScopeMessage.type = 'video';
    }

    this.hls.trigger(Event.BUFFER_FLUSHING, flushScopeMessage);
  }

  onBufferCreated (data) {
    let tracks = data.tracks, mediaTrack, name, alternate = false;
    for (let type in tracks) {
      let track = tracks[type];
      if (track.id === 'main') {
        name = type;
        mediaTrack = track;
        // keep video source buffer reference
        if (type === 'video') {
          this.videoBuffer = tracks[type].buffer;
        }
      } else {
        alternate = true;
      }
    }
    if (alternate && mediaTrack) {
      logger.log(`alternate track found, use ${name}.buffered to schedule main fragment loading`);
      this.mediaBuffer = mediaTrack.buffer;
    } else {
      this.mediaBuffer = this._media;
    }
  }

  onBufferAppended (data) {
    this._pendingBuffering = (data.pending > 0);
    this._checkAppendedParsed();
  }

  onBufferFlushed () {
    /* after successful buffer flushing, filter flushed fragments from bufferedFrags
      use mediaBuffered instead of media (so that we will check against video.buffered ranges in case of alt audio track)
    */
    const media = this.mediaBuffer ? this.mediaBuffer : this._media;
    if (media) {
      // filter fragments potentially evicted from buffer. this is to avoid memleak on live streams
      this.fragmentTracker.detectEvictedFragments(MediaFragment.ElementaryStreamTypes.VIDEO, media.buffered);
    }

  }

  onFragLoading (data) {
    logger.debug('onFragLoading:', data);
  }

  onFragLoaded (data) {
    const { hls, _levels, _media } = this;
    const fragLoaded = data.frag;

    const stats = data.stats;
    const currentLevel = _levels[fragLoaded.level];
    const details = currentLevel.details;
    // reset frag bitrate test in any case after frag loaded event
    // if this frag was loaded to perform a bitrate test AND if hls.nextLoadLevel is greater than 0
    // then this means that we should be able to load a fragment at a higher quality level
    this._stats = stats;

    logger.log(`Loaded ${fragLoaded.sn} of [${details.startSN} ,${details.endSN}],level ${fragLoaded.level}`);
    if (hls.nextLoadLevel) {
      // switch back to IDLE state ... we just loaded a fragment to determine adequate start bitrate and initialize autoswitch algo
      stats.tparsed = stats.tbuffered = window.performance.now();
      hls.trigger(Event.FRAG_BUFFERED, { stats: stats, frag: fragLoaded, id: 'main' });
    } else if (fragLoaded.sn === -1) {
      stats.tparsed = stats.tbuffered = window.performance.now();
      details.initSegment.data = data.payload;
      hls.trigger(Event.FRAG_BUFFERED, { stats: stats, frag: fragLoaded, id: 'main' });
    } else {
      logger.log(`Parsing ${fragLoaded.sn} of [${details.startSN} ,${details.endSN}],level ${fragLoaded.level}, cc ${fragLoaded.cc}`);
      this._pendingBuffering = true;
      this._appended = false;

      // time Offset is accurate if level PTS is known, or if playlist is not sliding (not live) and if media is not seeking (this is to overcome potential timestamp drifts between playlists and fragments)
      const accurateTimeOffset = !(_media && _media.seeking) && (details.isPtsKnown || !details.live);
      const initSegmentData = details.initSegment ? details.initSegment.data : [];
      const audioCodec = this._getAudioCodec(currentLevel);

      // transmux the MPEG-TS data to ISO-BMFF segments
      const demuxer = this._demuxer = this._demuxer || new Demuxer(this.hls, 'main');
      demuxer.push(
        data.payload,
        initSegmentData,
        audioCodec,
        currentLevel.videoCodec,
        fragLoaded,
        details.totalduration,
        accurateTimeOffset
      );
    }
  }

  onFragParsingInitSegment (data) {
    const fragCurrent: MediaFragment = data.frag;

    let tracks = data.tracks, trackName, track;

    // if audio track is expected to come from audio stream controller, discard any coming from main
    if (tracks.audio && this._altAudio) {
      delete tracks.audio;
    }

    // include levelCodec in audio and video tracks
    track = tracks.audio;
    if (track) {
      let audioCodec = this._levels[this._currentLevelIndex].audioCodec,
        ua = navigator.userAgent.toLowerCase();
      if (audioCodec && this._audioCodecSwap) {
        logger.log('swapping playlist audio codec');
        if (audioCodec.indexOf('mp4a.40.5') !== -1) {
          audioCodec = 'mp4a.40.2';
        } else {
          audioCodec = 'mp4a.40.5';
        }
      }
      // in case AAC and HE-AAC audio codecs are signalled in manifest
      // force HE-AAC , as it seems that most browsers prefers that way,
      // except for mono streams OR on FF
      // these conditions might need to be reviewed ...
      if (this._audioCodecSwitch) {
        // don't force HE-AAC if mono stream
        if (track.metadata.channelCount !== 1 &&
          // don't force HE-AAC if firefox
          ua.indexOf('firefox') === -1) {
          audioCodec = 'mp4a.40.5';
        }
      }
      // HE-AAC is broken on Android, always signal audio codec as AAC even if variant manifest states otherwise
      if (ua.indexOf('android') !== -1 && track.container !== 'audio/mpeg') { // Exclude mpeg audio
        audioCodec = 'mp4a.40.2';
        logger.log(`Android: force audio codec to ${audioCodec}`);
      }
      track.levelCodec = audioCodec;
      track.id = data.id;
    }
    track = tracks.video;
    if (track) {
      track.levelCodec = this._levels[this._currentLevelIndex].videoCodec;
      track.id = data.id;
    }
    this.hls.trigger(Event.BUFFER_CODECS, tracks);
    // loop through tracks that are going to be provided to bufferController
    for (trackName in tracks) {
      track = tracks[trackName];
      logger.log(`Found track: ${trackName}, container:${track.container}, codecs[level/parsed]=[${track.levelCodec}/${track.codec}]`);
      let initSegment = track.initSegment;
      if (initSegment) {
        this._appended = true;
        // arm pending Buffering flag before appending a segment
        this._pendingBuffering = true;
        this.hls.trigger(Event.BUFFER_APPENDING, { type: trackName, data: initSegment, parent: 'main', content: 'initSegment' });
      }
    }
  }

  onFragParsingData (data) {
    if (this._altAudio) {
      return;
    }

    const level: QualityLevel = this._levels[this._currentLevelIndex];
    const frag: MediaFragment = data.frag;

    if (!Number.isFinite(data.endPTS)) {
      data.endPTS = data.startPTS + frag.duration;
      data.endDTS = data.startDTS + frag.duration;
    }

    if (data.hasAudio === true) {
      frag.addElementaryStream(MediaFragment.ElementaryStreamTypes.AUDIO);
    }

    if (data.hasVideo === true) {
      frag.addElementaryStream(MediaFragment.ElementaryStreamTypes.VIDEO);
    }

    logger.log(`Parsed ${data.type},PTS:[${data.startPTS.toFixed(3)},${data.endPTS.toFixed(3)}],DTS:[${data.startDTS.toFixed(3)}/${data.endDTS.toFixed(3)}],nb:${data.nb},dropped:${data.dropped || 0}`);

    // Detect gaps in a fragment  and try to fix it by finding a keyframe in the previous fragment (see _findFragments)
    if (data.type === 'video') {
      frag.framesDropped = data.dropped;
      if (frag.framesDropped) {
        if (!frag.backtracked) {
          const levelDetails = level.details;
          if (levelDetails && frag.sn === levelDetails.startSN) {
            logger.warn('missing video frame(s) on first frag, appending with gap', frag.sn);
          } else {
            logger.warn('missing video frame(s), backtracking fragment', frag.sn);
            // Return back to the IDLE state without appending to buffer
            // Causes findFragments to backtrack a segment and find the keyframe
            // Audio fragments arriving before video sets the nextLoadPosition, causing _findFragments to skip the backtracked fragment
            this.fragmentTracker.removeFragment(frag);
            frag.backtracked = true;

            return;
          }
        } else {
          logger.warn('Already backtracked on this fragment, appending with the gap', frag.sn);
        }
      } else {
        // Only reset the backtracked flag if we've loaded the frag without any dropped frames
        frag.backtracked = false;
      }
    }

    const drift = LevelHelper.updateFragPTSDTS(
      level.details,
      frag,
      data.startPTS,
      data.endPTS,
      data.startDTS,
      data.endDTS);

    const hls = this.hls;

    hls.trigger(Event.LEVEL_PTS_UPDATED, {
      details: level.details,
      level: this._currentLevelIndex,
      drift: drift,
      type: data.type,
      start: data.startPTS,
      end: data.endPTS
    });

    // has remuxer dropped video frames located before first keyframe ?
    [data.data1, data.data2].forEach(buffer => {
      // only append in PARSING state (rationale is that an appending error could happen synchronously on first segment appending)
      // in that case it is useless to append following segments
      if (buffer && buffer.length) {
        this._appended = true;
        // arm pending Buffering flag before appending a segment
        this._pendingBuffering = true;
        hls.trigger(Event.BUFFER_APPENDING, { type: data.type, data: buffer, parent: 'main', content: 'data' });
      }
    });
  }

  onFragParsed (data) {
    const fragCurrent = this._fragLoaded;
    const fragNew = data.frag;
    if (fragCurrent &&
        data.id === 'main' &&
        fragNew.sn === fragCurrent.sn &&
        fragNew.level === fragCurrent.level) {
      this._stats.tparsed = window.performance.now();
      this._checkAppendedParsed();
    }
  }

  private _checkAppendedParsed () {
    // trigger handler right now
    if ((!this._appended || !this._pendingBuffering)) {
      const frag = this._fragLoaded;
      if (frag) {
        const media = this.mediaBuffer ? this.mediaBuffer : this._media;
        logger.log(`main buffered : ${TimeRanges.toString(media.buffered)}`);

        const stats = this._stats;
        stats.tbuffered = window.performance.now();

        this.hls.trigger(Event.FRAG_BUFFERED, { stats: stats, frag: frag, id: 'main' });
      }
    }
  }

  private _getAudioCodec (currentLevel) {
    let audioCodec = this.config.defaultAudioCodec || currentLevel.audioCodec;
    if (this._audioCodecSwap) {
      logger.log('swapping playlist audio codec');
      if (audioCodec) {
        if (audioCodec.indexOf('mp4a.40.5') !== -1) {
          audioCodec = 'mp4a.40.2';
        } else {
          audioCodec = 'mp4a.40.5';
        }
      }
    }

    return audioCodec;
  }
}
