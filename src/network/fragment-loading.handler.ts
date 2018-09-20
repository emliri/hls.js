import { Event } from '../events';
import { EventHandler } from '../event-handler';
import { ErrorType, ErrorDetail } from '../errors';

import { logger } from '../utils/logger';
import { NetworkEngine,
  NetworkEngineContext,
  NetworkEngineCallbacks,
  NetworkEngineContextType,
  NetworkEngineLoadOptions } from './network-engine';
import { MediaFragment } from '../m3u8/media-fragment';
import { MediaVariantType } from '../m3u8/media-variant';

export class FragmentLoadingHandler extends EventHandler {
  private _loaders: {[type: string]: NetworkEngine};

  constructor (hls) {
    super(hls, Event.FRAG_LOADING);
    this._loaders = {};
  }

  destroy () {
    let loaders = this._loaders;
    for (let loaderName in loaders) {
      let loader = loaders[loaderName];
      if (loader) {
        loader.destroy();
      }
    }
    this._loaders = {};

    super.destroy();
  }

  onFragLoading (data: {frag: MediaFragment}) {
    const frag = data.frag;
    const type: MediaVariantType = frag.type;
    const loaders = this._loaders;
    const config = this.hls.config;

    // reset fragment state
    frag.loaded = 0;

    let loader = loaders[type];
    if (loader) {
      logger.warn(`abort previous fragment loader for type: ${type}`);
      loader.abort();
    }

    loader = loaders[type] = frag.loader = new NetworkEngine(config);

    let loaderContext: NetworkEngineContext;
    let loaderConfig: NetworkEngineLoadOptions;
    let loaderCallbacks: NetworkEngineCallbacks;

    loaderContext = {
      type: NetworkEngineContextType.MEDIA_FRAGMENT,
      id: null,
      loader: null,
      level: null,
      levelDetails: null,
      frag,
      url: frag.url,
      responseType: 'arraybuffer'
    };

    const start = frag.byteRangeStartOffset;
    const end = frag.byteRangeEndOffset;

    if (Number.isFinite(start) && Number.isFinite(end)) {
      loaderContext.rangeStart = start;
      loaderContext.rangeEnd = end;
    }

    loaderConfig = {
      timeout: config.fragLoadingTimeOut,
      maxRetry: 0,
      retryDelay: 0,
      maxRetryDelay: config.fragLoadingMaxRetryTimeout
    };

    loaderCallbacks = {
      onSuccess: this._handleSuccess.bind(this),
      onError: this._handleError.bind(this),
      onTimeout: this._handleTimeout.bind(this),
      onProgress: this._handleProgress.bind(this)
    };

    loader.load(loaderContext, loaderConfig, loaderCallbacks);
  }

  private _handleSuccess (response, stats, context, networkDetails = null) {
    let payload = response.data, frag = context.frag;
    // detach fragment loader on load success
    frag.loader = undefined;
    this._loaders[frag.type] = undefined;
    this.hls.trigger(Event.FRAG_LOADED, { payload: payload, frag: frag, stats: stats, networkDetails: networkDetails });
  }

  private _handleError (response, context, networkDetails = null) {
    const frag = context.frag;
    let loader = frag.loader;
    if (loader) {
      loader.abort();
    }

    this._loaders[frag.type] = undefined;
    this.hls.trigger(Event.ERROR, { type: ErrorType.NETWORK_ERROR, details: ErrorDetail.FRAG_LOAD_ERROR, fatal: false, frag: context.frag, response: response, networkDetails: networkDetails });
  }

  private _handleTimeout (stats, context, networkDetails = null) {
    const frag = context.frag;
    let loader = frag.loader;
    if (loader) {
      loader.abort();
    }

    this._loaders[frag.type] = undefined;
    this.hls.trigger(Event.ERROR, { type: ErrorType.NETWORK_ERROR, details: ErrorDetail.FRAG_LOAD_TIMEOUT, fatal: false, frag: context.frag, networkDetails: networkDetails });
  }

  // data will be used for progressive parsing
  private _handleProgress (stats, context, data, networkDetails = null) { // jshint ignore:line
    let frag = context.frag;
    frag.loaded = stats.loaded;
    this.hls.trigger(Event.FRAG_LOAD_PROGRESS, { frag: frag, stats: stats, networkDetails: networkDetails });
  }
}
