import { Observer } from "../observer";
import { EventHandler } from "../event-handler";
import { MediaFragment } from "../m3u8/media-fragment";
import { logger } from '../utils/logger';
import { Event } from '../events';
import TimeRanges from '../media-source-api/time-ranges';
import * as LevelHelper from '../m3u8/level-helper';

import Hls, { QualityLevel } from "../hls";
import Demuxer from "../transmux/demux/demuxer";
import { MediaFragmentTracker } from "./media-fragment-tracker";

export enum MediaFragmentReceiverState {
  STOPPED = 'STOPPED',
  IDLE = 'IDLE',
  KEY_LOADING = 'KEY_LOADING',
  FRAG_LOADING = 'FRAG_LOADING',
  FRAG_LOADING_WAITING_RETRY = 'FRAG_LOADING_WAITING_RETRY',
  WAITING_LEVEL = 'WAITING_LEVEL',
  PARSING = 'PARSING',
  PARSED = 'PARSED',
  BUFFER_FLUSHING = 'BUFFER_FLUSHING',
  ENDED = 'ENDED',
  ERROR = 'ERROR'
};

const State = MediaFragmentReceiverState;

export type MediaSourceBufferMessage = {
  type: 'video'
  startOffset?: number,
  endOffset?: number
};

export type MediaSourceBufferState = {
  buffered: TimeRanges;
}

export class MediaFragmentReceiver extends EventHandler {
  videoBuffer: any;
  mediaBuffer: any;
  media: any;
  state: MediaFragmentReceiverState;
  pendingBuffering: boolean;
  fragmentTracker: MediaFragmentTracker;
  fragPrevious: any;
  altAudio: any;
  appended: any;
  fragCurrent: MediaFragment;
  stats: any;
  fragLastKbps: number;
  bitrateTest: boolean;
  startFragRequested: boolean;

  demuxer: Demuxer;
  fragLoadError: number;
  levels: QualityLevel[];
  level: number;
  audioCodecSwap: any;
  audioCodecSwitch: any;
  nextLoadPosition: number;
  loadedmetadata: boolean;
  startPosition: number;
  stallReported: boolean;

  constructor(hls: Hls) {
    super(hls,
      Event.FRAG_LOADED,
      Event.FRAG_LOAD_EMERGENCY_ABORTED,
      Event.FRAG_PARSING_INIT_SEGMENT,
      Event.FRAG_PARSING_DATA,
      Event.FRAG_PARSED,
      Event.BUFFER_CREATED,
      Event.BUFFER_APPENDED,
      Event.BUFFER_FLUSHED
      );

      this.stallReported = false;
      this.state = State.STOPPED;

      //this.fragmentTracker = new MediaFragmentTracker(this.hls);
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
      this.mediaBuffer = this.media;
    }
  }

  onBufferAppended (data) {
    if (data.parent === 'main') {
      const state = this.state;
      if (state === State.PARSING || state === State.PARSED) {
        // check if all buffers have been appended
        this.pendingBuffering = (data.pending > 0);
        this._checkAppendedParsed();
      }
    }
  }

  onBufferFlushed () {
    /* after successful buffer flushing, filter flushed fragments from bufferedFrags
      use mediaBuffered instead of media (so that we will check against video.buffered ranges in case of alt audio track)
    */
    const media = this.mediaBuffer ? this.mediaBuffer : this.media;
    if (media) {
      // filter fragments potentially evicted from buffer. this is to avoid memleak on live streams
      this.fragmentTracker.detectEvictedFragments(MediaFragment.ElementaryStreamTypes.VIDEO, media.buffered);
    }
    // move to IDLE once flush complete. this should trigger new fragment loading
    this.state = State.IDLE;
    // reset reference to frag
    this.fragPrevious = null;
  }

  flushMainBuffer (startOffset, endOffset) {
    this.state = State.BUFFER_FLUSHING;
    let flushScopeMessage: MediaSourceBufferMessage = {
      startOffset,
      endOffset,
      type: null
    };
    // if alternate audio tracks are used, only flush video, otherwise flush everything
    if (this.altAudio) {
      flushScopeMessage.type = 'video';
    }

    this.hls.trigger(Event.BUFFER_FLUSHING, flushScopeMessage);
  }


  _checkAppendedParsed () {
    // trigger handler right now
    if (this.state === State.PARSED && (!this.appended || !this.pendingBuffering)) {
      const frag = this.fragCurrent;
      if (frag) {
        const media = this.mediaBuffer ? this.mediaBuffer : this.media;
        logger.log(`main buffered : ${TimeRanges.toString(media.buffered)}`);
        this.fragPrevious = frag;
        const stats = this.stats;
        stats.tbuffered = window.performance.now();
        // we should get rid of this.fragLastKbps
        this.fragLastKbps = Math.round(8 * stats.total / (stats.tbuffered - stats.tfirst));
        this.hls.trigger(Event.FRAG_BUFFERED, { stats: stats, frag: frag, id: 'main' });
        this.state = State.IDLE;
      }
      this.tick();
    }
  }

  tick(): any {
    throw new Error("Method not implemented.");
  }

  onFragLoaded (data) {
    const { fragCurrent, hls, levels, media } = this;
    const fragLoaded = data.frag;
    if (this.state === State.FRAG_LOADING &&
        fragCurrent &&
        fragLoaded.type === 'main' &&
        fragLoaded.level === fragCurrent.level &&
        fragLoaded.sn === fragCurrent.sn) {
      const stats = data.stats;
      const currentLevel = levels[fragCurrent.level];
      const details = currentLevel.details;
      // reset frag bitrate test in any case after frag loaded event
      // if this frag was loaded to perform a bitrate test AND if hls.nextLoadLevel is greater than 0
      // then this means that we should be able to load a fragment at a higher quality level
      this.bitrateTest = false;
      this.stats = stats;

      logger.log(`Loaded ${fragCurrent.sn} of [${details.startSN} ,${details.endSN}],level ${fragCurrent.level}`);
      if (fragLoaded.bitrateTest && hls.nextLoadLevel) {
        // switch back to IDLE state ... we just loaded a fragment to determine adequate start bitrate and initialize autoswitch algo
        this.state = State.IDLE;
        this.startFragRequested = false;
        stats.tparsed = stats.tbuffered = window.performance.now();
        hls.trigger(Event.FRAG_BUFFERED, { stats: stats, frag: fragCurrent, id: 'main' });
        this.tick();
      } else if (fragLoaded.sn === -1) {
        this.state = State.IDLE;
        stats.tparsed = stats.tbuffered = window.performance.now();
        details.initSegment.data = data.payload;
        hls.trigger(Event.FRAG_BUFFERED, { stats: stats, frag: fragCurrent, id: 'main' });
        this.tick();
      } else {
        logger.log(`Parsing ${fragCurrent.sn} of [${details.startSN} ,${details.endSN}],level ${fragCurrent.level}, cc ${fragCurrent.cc}`);
        this.state = State.PARSING;
        this.pendingBuffering = true;
        this.appended = false;

        // Bitrate test frags are not usually buffered so the fragment tracker ignores them. If Hls.js decides to buffer
        // it (and therefore ends up at this line), then the fragment tracker needs to be manually informed.
        if (fragLoaded.bitrateTest) {
          fragLoaded.bitrateTest = false;
          this.fragmentTracker.onFragLoaded({
            frag: fragLoaded
          });
        }

        // time Offset is accurate if level PTS is known, or if playlist is not sliding (not live) and if media is not seeking (this is to overcome potential timestamp drifts between playlists and fragments)
        const accurateTimeOffset = !(media && media.seeking) && (details.PTSKnown || !details.live);
        const initSegmentData = details.initSegment ? details.initSegment.data : [];
        const audioCodec = this._getAudioCodec(currentLevel);

        // transmux the MPEG-TS data to ISO-BMFF segments
        const demuxer = this.demuxer = this.demuxer || new Demuxer(this.hls, 'main');
        demuxer.push(
          data.payload,
          initSegmentData,
          audioCodec,
          currentLevel.videoCodec,
          fragCurrent,
          details.totalduration,
          accurateTimeOffset
        );
      }
    }
    this.fragLoadError = 0;
  }
  _getAudioCodec(currentLevel: any): any {
    throw new Error("Method not implemented.");
  }

  onFragParsingInitSegment (data) {
    const fragCurrent = this.fragCurrent;
    const fragNew = data.frag;

    if (fragCurrent &&
        data.id === 'main' &&
        fragNew.sn === fragCurrent.sn &&
        fragNew.level === fragCurrent.level &&
        this.state === State.PARSING) {
      let tracks = data.tracks, trackName, track;

      // if audio track is expected to come from audio stream controller, discard any coming from main
      if (tracks.audio && this.altAudio) {
        delete tracks.audio;
      }

      // include levelCodec in audio and video tracks
      track = tracks.audio;
      if (track) {
        let audioCodec = this.levels[this.level].audioCodec,
          ua = navigator.userAgent.toLowerCase();
        if (audioCodec && this.audioCodecSwap) {
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
        if (this.audioCodecSwitch) {
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
        track.levelCodec = this.levels[this.level].videoCodec;
        track.id = data.id;
      }
      this.hls.trigger(Event.BUFFER_CODECS, tracks);
      // loop through tracks that are going to be provided to bufferController
      for (trackName in tracks) {
        track = tracks[trackName];
        logger.log(`main track:${trackName},container:${track.container},codecs[level/parsed]=[${track.levelCodec}/${track.codec}]`);
        let initSegment = track.initSegment;
        if (initSegment) {
          this.appended = true;
          // arm pending Buffering flag before appending a segment
          this.pendingBuffering = true;
          this.hls.trigger(Event.BUFFER_APPENDING, { type: trackName, data: initSegment, parent: 'main', content: 'initSegment' });
        }
      }
      // trigger handler right now
      this.tick();
    }
  }

  onFragParsingData (data) {
    const fragCurrent = this.fragCurrent;
    const fragNew = data.frag;
    if (fragCurrent &&
        data.id === 'main' &&
        fragNew.sn === fragCurrent.sn &&
        fragNew.level === fragCurrent.level &&
        !(data.type === 'audio' && this.altAudio) && // filter out main audio if audio track is loaded through audio stream controller
        this.state === State.PARSING) {
      let level = this.levels[this.level],
        frag = fragCurrent;
      if (!Number.isFinite(data.endPTS)) {
        data.endPTS = data.startPTS + fragCurrent.duration;
        data.endDTS = data.startDTS + fragCurrent.duration;
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
        frag.dropped = data.dropped;
        if (frag.dropped) {
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
              this.nextLoadPosition = data.startPTS;
              this.state = State.IDLE;
              this.fragPrevious = frag;
              this.tick();
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

      let drift = LevelHelper.updateFragPTSDTS(level.details, frag, data.startPTS, data.endPTS, data.startDTS, data.endDTS),
        hls = this.hls;
      hls.trigger(Event.LEVEL_PTS_UPDATED, { details: level.details, level: this.level, drift: drift, type: data.type, start: data.startPTS, end: data.endPTS });
      // has remuxer dropped video frames located before first keyframe ?
      [data.data1, data.data2].forEach(buffer => {
        // only append in PARSING state (rationale is that an appending error could happen synchronously on first segment appending)
        // in that case it is useless to append following segments
        if (buffer && buffer.length && this.state === State.PARSING) {
          this.appended = true;
          // arm pending Buffering flag before appending a segment
          this.pendingBuffering = true;
          hls.trigger(Event.BUFFER_APPENDING, { type: data.type, data: buffer, parent: 'main', content: 'data' });
        }
      });
      // trigger handler right now
      this.tick();
    }
  }

  onFragParsed (data) {
    const fragCurrent = this.fragCurrent;
    const fragNew = data.frag;
    if (fragCurrent &&
        data.id === 'main' &&
        fragNew.sn === fragCurrent.sn &&
        fragNew.level === fragCurrent.level &&
        this.state === State.PARSING) {
      this.stats.tparsed = window.performance.now();
      this.state = State.PARSED;
      this._checkAppendedParsed();
    }
  }

  onFragLoadEmergencyAborted () {
    this.state = State.IDLE;
    // if loadedmetadata is not set, it means that we are emergency switch down on first frag
    // in that case, reset startFragRequested flag
    if (!this.loadedmetadata) {
      this.startFragRequested = false;
      this.nextLoadPosition = this.startPosition;
    }
    this.tick();
  }
}
