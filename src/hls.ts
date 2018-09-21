/**
 * @module Hls
 * @class
 * @constructor
 */

import * as URLToolkit from 'url-toolkit';

import {
  ErrorType,
  ErrorDetail
} from './errors';

import { isSupported } from './is-supported';

import { logger, enableLogs } from './utils/logger';

import { hlsDefaultConfig } from './config';

import { Event } from './events';

import { Observer } from './observer';

import { AttrList } from './m3u8/attr-list';
import { MediaFragment } from './m3u8/media-fragment';

import { PlaylistLoadingHandler } from './network/playlist-loading.handler';
import { FragmentLoadingHandler } from './network/fragment-loading.handler';
import { KeyLoadingHandler } from './network/key-loading.handler';

import { AbrHandler } from './abr/abr.handler';
import { CapLevelHandler } from './abr/cap-level.handler';

import { MSEProxyHandler } from './media-source-api/mse-proxy.handler';

import { FrameDropMonitor } from './abr/frame-drop-monitor.handler';

import { MediaVariantsHandler } from './track-controller/media-variants.handler';
import { AudioTracksHandler } from './track-controller/audio-tracks.handler';
import { SubtitleTracksHandler } from './track-controller/subtitle-tracks.handler';
import { Id3TrackHandler } from './text/id3-track.handler';

import { EMEProxyHandler } from './drm/eme-proxy.handler';

import { TimelineRenderer } from './text/timeline-renderer';

import { MediaFragmentTracker } from './stream-scheduler/media-fragment-tracker';
import AudioStreamController from './stream-scheduler/audio-stream-controller';
import SubtitleStreamController from './stream-scheduler/subtitle-stream-controller';
import { StreamSchedulingHandler } from './stream-scheduler/stream-scheduling.handler';

import { NetworkEngineSetupFn } from './network/network-engine';
import { TaskRunningService } from './task-running-service';

declare const __VERSION__: string;

const _logger: any = logger;

const _hlsDefaultConfig: any = hlsDefaultConfig;

export type HlsConfig = {
  autoStartLoad: boolean, // used by stream-controller
  startPosition: number, // used by stream-controller
  defaultAudioCodec: string, // used by stream-controller
  debug: boolean, // used by logger
  capLevelOnFPSDrop: boolean, // used by fps-controller
  capLevelToPlayerSize: boolean, // used by cap-level-controller
  initialLiveManifestSize: number, // used by stream-controller
  maxBufferLength: number, // used by stream-controller
  maxBufferSize: number, // used by stream-controller
  maxBufferHole: number, // used by stream-controller

  lowBufferWatchdogPeriod: number, // used by stream-controller
  highBufferWatchdogPeriod: number, // used by stream-controller
  nudgeOffset: number, // used by stream-controller
  nudgeMaxRetry: number, // used by stream-controller
  maxFragLookUpTolerance: number, // used by stream-controller
  liveSyncDurationCount: number, // used by stream-controller
  liveMaxLatencyDurationCount: number, // used by stream-controller
  liveSyncDuration: number, // used by stream-controller
  liveMaxLatencyDuration: number, // used by stream-controller
  liveDurationInfinity: boolean, // used by buffer-controller
  maxMaxBufferLength: number, // used by stream-controller
  enableWorker: boolean, // used by demuxer
  enableSoftwareAES: boolean, // used by decrypter
  manifestLoadingTimeOut: number, // used by playlist-loader
  manifestLoadingMaxRetry: number, // used by playlist-loader
  manifestLoadingRetryDelay: number, // used by playlist-loader
  manifestLoadingMaxRetryTimeout: number, // used by playlist-loader
  startLevel: number, // used by level-controller
  levelLoadingTimeOut: number, // used by playlist-loader
  levelLoadingMaxRetry: number, // used by playlist-loader
  levelLoadingRetryDelay: number, // used by playlist-loader
  levelLoadingMaxRetryTimeout: number, // used by playlist-loader
  fragLoadingTimeOut: number, // used by fragment-loader
  fragLoadingMaxRetry: number, // used by fragment-loader
  fragLoadingRetryDelay: number, // used by fragment-loader
  fragLoadingMaxRetryTimeout: number, // used by fragment-loader
  startFragPrefetch: boolean, // used by stream-controller
  fpsDroppedMonitoringPeriod: number, // used by fps-controller
  fpsDroppedMonitoringThreshold: number, // used by fps-controller
  appendErrorMaxRetry: number, // used by buffer-controller
  stretchShortVideoTrack: boolean, // used by mp4-remuxer
  maxAudioFramesDrift: number, // used by mp4-remuxer
  forceKeyFrameOnDiscontinuity: boolean, // used by ts-demuxer
  abrEwmaFastLive: number, // used by abr-controller
  abrEwmaSlowLive: number, // used by abr-controller
  abrEwmaFastVoD: number, // used by abr-controller
  abrEwmaSlowVoD: number, // used by abr-controller
  abrEwmaDefaultEstimate: number, // used by abr-controller
  abrBandWidthFactor: number, // used by abr-controller
  abrBandWidthUpFactor: number, // used by abr-controller
  abrMaxWithRealBitrate: boolean, // used by abr-controller
  maxStarvationDelay: number, // used by abr-controller
  maxLoadingDelay: number, // used by abr-controller
  minAutoBitrate: number, // used by hls
  emeEnabled: boolean, // used by eme-controller
  widevineLicenseUrl: string | null, // used by eme-controller

  xhrSetup: NetworkEngineSetupFn, // used by xhr-loader
  licenseXhrSetup: NetworkEngineSetupFn, // used by eme-controller

  enableCEA708Captions: boolean, // used by timeline-controller
  enableWebVTT: boolean, // used by timeline-controller
  captionsTextTrack1Label: string, // used by timeline-controller
  captionsTextTrack1LanguageCode: string, // used by timeline-controller
  captionsTextTrack2Label: string; // used by timeline-controller
  captionsTextTrack2LanguageCode: string // used by timeline-controller
};

export enum AlternateMediaType {
  AUDIO = 'AUDIO',
  SUBTITLES = 'SUBTITLES'
}

export type MediaVariantDetails = {
  PTSKnown: boolean,
  fragments: MediaFragment[],
  url: string,
  readonly hasProgramDateTime: boolean,
  live: boolean,
  averagetargetduration: number,
  targetduration: number,
  totalduration: number,
  startCC: number,
  endCC: number,
  startSN: number,
  endSN: number,
  startTimeOffset: number | null,
  tload: number | null,
  type: string | null,
  version: number | null,
  initSegment: MediaFragment | null
  needSidxRanges: boolean,
  audioGroupIds: string[],
  subtitleGroupIds: string[]

};

export type AlternateMediaTrack = {
  id: number,
  groupId: string,
  autoselect: boolean,
  default: boolean,
  forced: boolean,
  lang: string,
  name: string,
  type: AlternateMediaType
  url: string,
  details?: MediaVariantDetails
  audioCodec?: string,
  subtitleCodec?: string
};

export type AlternateMediaSet = {
  [type in AlternateMediaType]: AlternateMediaTrack[]
};

export type QualityLevel = {
  attrs: AttrList,
  audioCodec: string,
  videoCodec: string,
  unknownCodecs: string[],
  bitrate: number,
  realBitrate?: number,
  fragmentError: boolean,
  height: number,
  width: number,
  name: string,
  url: string[] | string,
  urlId: number,
  audioGroupdIds: string[],
  textGroupdIds: string[],
  details: MediaVariantDetails
};

export type AudioTrack = AlternateMediaTrack & {

};

export type SubtitleTrack = AlternateMediaTrack & {

};

/**
 * @module Hls
 * @class
 * @constructor
 */
export default class Hls extends Observer {
  private static _defaultConfig: HlsConfig;

  /**
   * @type {string}
   */
  static get version (): string {
    return __VERSION__;
  }

  /**
   * @type {boolean}
   */
  static isSupported (): boolean {
    return isSupported();
  }

  /**
   * @type {Events}
   */
  static get Events (): typeof Event {
    return Event;
  }

  /**
   * @type {HlsErrorType}
   */
  static get ErrorTypes (): typeof ErrorType {
    return ErrorType;
  }

  /**
   * @type {HlsErrorDetail}
   */
  static get ErrorDetails (): typeof ErrorDetail {
    return ErrorDetail;
  }

  /**
   * @type {HlsConfig}
   */
  static get DefaultConfig (): HlsConfig {
    if (!Hls._defaultConfig) {
      return _hlsDefaultConfig;
    }

    return Hls._defaultConfig;
  }

  /**
   * @type {HlsConfig}
   */
  static set DefaultConfig (defaultConfig: HlsConfig) {
    Hls._defaultConfig = defaultConfig;
  }

  private _config: HlsConfig;

  // Fixme: should be in cap-controller
  private _autoLevelCapping: number;

  private fragmentTracker: MediaFragmentTracker;
  private streamScheduler: StreamSchedulingHandler;
  private audioStreamController: AudioStreamController;
  private subtitleStreamController: SubtitleStreamController;

  private audioTrackController: AudioTracksHandler;
  private subtitleTrackController: SubtitleTracksHandler;
  private levelController: MediaVariantsHandler;

  private timelineRenderer: TimelineRenderer;
  private id3TrackController: Id3TrackHandler;

  private emeProxy: EMEProxyHandler;

  private abrController: AbrHandler;
  private capLevelController: CapLevelHandler;
  private fpsController: FrameDropMonitor;

  private bufferController: MSEProxyHandler;

  private playlistLoader: PlaylistLoadingHandler;
  private fragmentLoader: FragmentLoadingHandler;
  private keyLoader: KeyLoadingHandler;

  private url: string;
  private media: HTMLMediaElement;

  private _taskRunningService: TaskRunningService = new TaskRunningService();

  /**
   * Creates an instance of an HLS client that can attach to exactly one `HTMLMediaElement`.
   *
   * @constructs Hls
   * @param {HlsConfig} config
   */
  constructor (config: Partial<HlsConfig> = {}) {
    super();

    enableLogs(config.debug);

    this._config = Object.assign(config, Hls.DefaultConfig);

    if ((config.liveSyncDurationCount || config.liveMaxLatencyDurationCount) && (config.liveSyncDuration || config.liveMaxLatencyDuration)) {
      throw new Error('Illegal hls.js config: don\'t mix up liveSyncDurationCount/liveMaxLatencyDurationCount and liveSyncDuration/liveMaxLatencyDuration');
    }

    if (config.liveMaxLatencyDurationCount !== undefined && config.liveMaxLatencyDurationCount <= config.liveSyncDurationCount) {
      throw new Error('Illegal hls.js config: "liveMaxLatencyDurationCount" must be gt "liveSyncDurationCount"');
    }

    if (config.liveMaxLatencyDuration !== undefined && (config.liveMaxLatencyDuration <= config.liveSyncDuration || config.liveSyncDuration === undefined)) {
      throw new Error('Illegal hls.js config: "liveMaxLatencyDuration" must be gt "liveSyncDuration"');
    }

    /**
     * @private
     * @member {number}
     */
    this._autoLevelCapping = -1;

    // ABR
    this.abrController = new AbrHandler(this);
    this.capLevelController = new CapLevelHandler(this);
    this.fpsController = new FrameDropMonitor(this);

    // Network
    this.playlistLoader = new PlaylistLoadingHandler(this);
    this.fragmentLoader = new FragmentLoadingHandler(this);
    this.keyLoader = new KeyLoadingHandler(this);

    // Streaming
    this.fragmentTracker = new MediaFragmentTracker(this); // order matters
    this.streamScheduler = new StreamSchedulingHandler(this, this.fragmentTracker);
    this.audioStreamController = new AudioStreamController(this, this.fragmentTracker);
    this.subtitleStreamController = new SubtitleStreamController(this, this.fragmentTracker);

    // Track-control
    this.audioTrackController = new AudioTracksHandler(this);
    this.levelController = new MediaVariantsHandler(this);
    this.subtitleTrackController = new SubtitleTracksHandler(this);

    // DRM
    this.emeProxy = new EMEProxyHandler(this);

    // Decode/Rendering
    this.id3TrackController = new Id3TrackHandler(this);
    this.timelineRenderer = new TimelineRenderer(this);
    this.bufferController = new MSEProxyHandler(this);
  }

  get config (): HlsConfig {
    return this._config;
  }

  /**
   * Dispose of the instance
   */
  destroy () {
    _logger.log('destroy');
    this.trigger(Event.DESTROYING);
    this.detachMedia();

    // TODO: register components for "destruction"
    /*
    this.coreComponents.forEach(component => {
      component.destroy();
    });
    */

    this.url = null;
    this.removeAllListeners();
  }

  /**
   * Attach a media element
   * @param {HTMLMediaElement} media
   */
  attachMedia (media: HTMLMediaElement) {
    _logger.log('attachMedia');
    this.media = media;
    this.trigger(Event.MEDIA_ATTACHING, { media: media });
  }

  /**
   * Detach from the media
   */
  detachMedia (): void {
    _logger.log('detachMedia');
    this.trigger(Event.MEDIA_DETACHING);
    this.media = null;
  }

  /**
   * Set the source URL. Can be relative or absolute.
   * @param {string} url
   */
  loadSource (url: string): void {
    url = URLToolkit.buildAbsoluteURL(window.location.href, url, { alwaysNormalize: true });
    _logger.log(`loadSource: ${url}`);
    this.url = url;
    // when attaching to a source URL, trigger a playlist load
    this.trigger(Event.MANIFEST_LOADING, { url: url });
  }

  /**
   * Start loading data from the stream source.
   * Depending on default config, client starts loading automatically when a source is set.
   *
   * @param {number} startPosition Set the start position to stream from
   * @default -1 None (from earliest point)
   */
  startLoad (startPosition: number = -1): void {
    _logger.log(`startLoad(${startPosition})`);

    // FIXME: At least LevelController should be kicked off by an event instead
    //        since it doesn't even take a start-position
    this.levelController.startLoad();

    // FIXME: Shouldn't all of this be kicked off by an event?
    this.streamScheduler.startLoad(startPosition);
    if (this.audioStreamController) {
      this.audioStreamController.startLoad(startPosition);
    }
  }

  /**
   * Stop loading of any stream data.
   */
  stopLoad (): void {
    _logger.log('stopLoad');

    this.levelController.stopLoad();
    this.streamScheduler.stopLoad();
    if (this.audioStreamController) {
      this.audioStreamController.stopLoad();
    }
  }

  /**
   * Swap through possible audio codecs in the stream (for example to switch from stereo to 5.1)
   */
  swapAudioCodec (): void {
    _logger.log('swapAudioCodec');
    this.streamScheduler.swapAudioCodec();
  }

  /**
   * When the media-element fails, this allows to detach and then re-attach it
   * as one call (convenience method).
   *
   * Automatic recovery of media-errors by this process is configurable.
   */
  recoverMediaError (): void {
    _logger.log('recoverMediaError');
    let media = this.media;
    this.detachMedia();
    this.attachMedia(media);
  }

  /**
   * @type {QualityLevel[]}
   */
  get levels (): QualityLevel[] {
    return this.levelController.levels;
  }

  /**
   * Index of quality level currently played
   * @type {number}
   */
  get currentLevel (): number {
    return this.streamScheduler.getCurrentLevelIndex();
  }

  /**
   * Set quality level index immediately .
   * This will flush the current buffer to replace the quality asap.
   * That means playback will interrupt at least shortly to re-buffer and re-sync eventually.
   * @type {number} -1 for automatic level selection
   */
  set currentLevel (newLevel: number) {
    _logger.log(`set currentLevel:${newLevel}`);
    this.loadLevel = newLevel;
    this.streamScheduler.doImmediateLevelSwitch();
  }

  /**
   * Index of next quality level loaded as scheduled by stream controller.
   * @type {number}
   */
  get nextLevel (): number {
      const frag = this.streamScheduler.getNextBufferedFragment();
      if (frag) {
        return frag.level;
      } else {
        return -1;
      }
  }

  /**
   * Set quality level index for next loaded data.
   * This will switch the video quality asap, without interrupting playback.
   * May abort current loading of data, and flush parts of buffer (outside currently played fragment region).
   * @type {number} -1 for automatic level selection
   */
  set nextLevel (newLevel: number) {
    _logger.log(`set nextLevel: ${newLevel}`);
    this.levelController.manualLevel = newLevel;
    this.streamScheduler.doNextLevelSwitch();
  }

  /**
   * Return the quality level of the currently or last (of none is loaded currently) segment
   * @type {number}
   */
  get loadLevel (): number {
    return this.levelController.level;
  }

  /**
   * Set quality level index for next loaded data in a conservative way.
   * This will switch the quality without flushing, but interrupt current loading.
   * Thus the moment when the quality switch will appear in effect will only be after the already existing buffer.
   * @type {number} newLevel -1 for automatic level selection
   */
  set loadLevel (newLevel: number) {
    _logger.log(`set loadLevel: ${newLevel}`);
    this.levelController.manualLevel = newLevel;
  }

  /**
   * get next quality level loaded
   * @type {number}
   */
  get nextLoadLevel (): number {
    return 0;
    // return this.levelController.nextLoadLevel;
  }

  /**
   * Set quality level of next loaded segment in a fully "non-destructive" way.
   * Same as `loadLevel` but will wait for next switch (until current loading is done).
   * @type {number} level
   */
  set nextLoadLevel (level: number) {
    // this.levelController.nextLoadLevel = level;
  }

  /**
   * Return "first level": like a default level, if not set,
   * falls back to index of first level referenced in manifest
   * @type {number}
   */
  get firstLevel (): number {
    return Math.max(this.levelController.firstLevel, this.minAutoLevel);
  }

  /**
   * Sets "first-level", see getter.
   * @type {number}
   */
  set firstLevel (newLevel: number) {
    _logger.log(`set firstLevel: ${newLevel}`);
    this.levelController.firstLevel = newLevel;
  }

  /**
   * Return start level (level of first fragment that will be played back)
   * if not overrided by user, first level appearing in manifest will be used as start level
   * if -1 : automatic start level selection, playback will start from level matching download bandwidth
   * (determined from download of first segment)
   * @type {number}
   */
  get startLevel (): number {
    return this.levelController.startLevel;
  }

  /**
   * set  start level (level of first fragment that will be played back)
   * if not overrided by user, first level appearing in manifest will be used as start level
   * if -1 : automatic start level selection, playback will start from level matching download bandwidth
   * (determined from download of first segment)
   * @type {number} newLevel
   */
  set startLevel (newLevel: number) {
    _logger.log(`set startLevel: ${newLevel}`);
    const hls = this;
    // if not in automatic start level detection, ensure startLevel is greater than minAutoLevel
    if (newLevel !== -1) {
      newLevel = Math.max(newLevel, hls.minAutoLevel);
    }

    hls.levelController.startLevel = newLevel;
  }

  /**
   * Capping/max level value that should be used by automatic level selection algorithm (`ABRController`)
   * @type {number}
   */
  get autoLevelCapping (): number {
    return this._autoLevelCapping;
  }

  /**
   * Capping/max level value that should be used by automatic level selection algorithm (`ABRController`)
   * @type {number}
   */
  set autoLevelCapping (newLevel) {
    logger.log(`set autoLevelCapping: ${newLevel}`);
    this._autoLevelCapping = newLevel;
  }

  /**
   * True when automatic level selection enabled
   * @type {boolean}
   */
  get autoLevelEnabled (): boolean {
    return (this.levelController.manualLevel === -1);
  }

  /**
   * Level set manually (if any)
   * @type {number}
   */
  get manualLevel (): number {
    return this.levelController.manualLevel;
  }

  /**
   * min level selectable in auto mode according to config.minAutoBitrate
   * @type {number}
   */
  get minAutoLevel (): number {
    const hls = this;
    const levels = hls.levels;
    const minAutoBitrate = hls._config.minAutoBitrate;
    const len = levels ? levels.length : 0;

    for (let i = 0; i < len; i++) {
      const levelNextBitrate = levels[i].realBitrate ? Math.max(levels[i].realBitrate, levels[i].bitrate) : levels[i].bitrate;
      if (levelNextBitrate > minAutoBitrate) {
        return i;
      }
    }

    return 0;
  }

  /**
   * max level selectable in auto mode according to autoLevelCapping
   * @type {number}
   */
  get maxAutoLevel (): number {
    const hls = this;
    const levels = hls.levels;
    const autoLevelCapping = hls.autoLevelCapping;
    let maxAutoLevel;
    if (autoLevelCapping === -1 && levels && levels.length) {
      maxAutoLevel = levels.length - 1;
    } else {
      maxAutoLevel = autoLevelCapping;
    }

    return maxAutoLevel;
  }

  /**
   * next automatically selected quality level
   * @type {number}
   */
  get nextAutoLevel (): number {
    const hls = this;
    // ensure next auto level is between  min and max auto level
    return Math.min(Math.max(hls.abrController.nextAutoLevel, hls.minAutoLevel), hls.maxAutoLevel);
  }

  /**
   * this setter is used to force next auto level.
   * this is useful to force a switch down in auto mode:
   * in case of load error on level N, hls.js can set nextAutoLevel to N-1 for example)
   * forced value is valid for one fragment. upon succesful frag loading at forced level,
   * this value will be resetted to -1 by ABR controller.
   * @type {number}
   */
  set nextAutoLevel (nextLevel: number) {
    const hls = this;
    hls.abrController.nextAutoLevel = Math.max(hls.minAutoLevel, nextLevel);
  }

  /**
   * @type {AudioTrack[]}
   */
  get audioTracks (): AudioTrack[] {
    const audioTrackController = this.audioTrackController;
    if (this.audioTrackController) {
      const audioTracks: any = audioTrackController.audioTracks;
      return audioTracks;
    } else {
      return [];
    }
  }

  /**
   * index of the selected audio track (index in audio track lists)
   * @type {number}
   */
  get audioTrack () {
    const audioTrackController = this.audioTrackController;
    return audioTrackController ? audioTrackController.audioTrack : -1;
  }

  /**
   * selects an audio track, based on its index in audio track lists
   * @type {number}
   */
  set audioTrack (audioTrackId) {
    const audioTrackController = this.audioTrackController;
    if (audioTrackController) {
      audioTrackController.audioTrack = audioTrackId;
    }
  }

  /**
   * @type {number} in seconds
   */
  get liveSyncPosition (): number {
    return this.streamScheduler.liveSyncPosition;
  }

  /**
   * get alternate subtitle tracks list from playlist
   * @type {SubtitleTrack[]}
   */
  get subtitleTracks (): SubtitleTrack[] {
    const subtitleTrackController = this.subtitleTrackController;
    return subtitleTrackController ? subtitleTrackController.subtitleTracks : [];
  }

  /**
   * index of the selected subtitle track (index in subtitle track lists)
   * @type {number}
   */
  get subtitleTrack () {
    const subtitleTrackController = this.subtitleTrackController;
    return subtitleTrackController ? subtitleTrackController.subtitleTrack : -1;
  }

  /**
   * select an subtitle track, based on its index in subtitle track lists
   * @type {number}
   */
  set subtitleTrack (subtitleTrackId: number) {
    const subtitleTrackController = this.subtitleTrackController;
    if (subtitleTrackController) {
      subtitleTrackController.subtitleTrack = subtitleTrackId;
    }
  }

  /**
   * @type {boolean}
   */
  get subtitleDisplay (): boolean {
    const subtitleTrackController = this.subtitleTrackController;
    return subtitleTrackController ? subtitleTrackController.subtitleDisplay : false;
  }

  /**
   * Enable/disable subtitle display rendering
   * @type {boolean}
   */
  set subtitleDisplay (value: boolean) {
    const subtitleTrackController = this.subtitleTrackController;
    if (subtitleTrackController) {
      subtitleTrackController.subtitleDisplay = value;
    }
  }

  getTaskRunningService (): TaskRunningService {
    return this._taskRunningService;
  }
}
