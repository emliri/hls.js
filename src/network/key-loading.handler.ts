import { Event } from '../events';
import { EventHandler } from '../event-handler';
import { ErrorType, ErrorDetail } from '../errors';
import { logger } from '../utils/logger';
import { NetworkEngineContextMap, NetworkEngine, NetworkEngineCallbacks, NetworkEngineContext, NetworkEngineContextType, NetworkEngineLoadOptions } from './network-engine';
import { MediaFragment } from '../m3u8/media-fragment';

export class KeyLoadingHandler extends EventHandler {
  private _loaders: {[type: string]: NetworkEngine};

  private _keyData: Uint8Array;
  private _keyUrl: string;

  constructor (hls) {
    super(hls, Event.KEY_LOADING);
    this._loaders = {};
    this._keyData = null;
    this._keyUrl = null;
  }

  destroy () {
    for (let loaderName in this._loaders) {
      let loader = this._loaders[loaderName];
      if (loader) {
        loader.destroy();
      }
    }
    this._loaders = {};

    super.destroy();
  }

  onKeyLoading (data: {frag: MediaFragment}) {
    let frag = data.frag,
      type = frag.type,
      loader = this._loaders[type],
      decryptdata = frag.decryptdata,
      uri = decryptdata.uri;

    // if uri is different from previous one or if decrypt key not retrieved yet
    if (uri !== this._keyUrl || this._keyData === null) {
      let config = this.hls.config;

      if (loader) {
        logger.warn(`abort previous key loader for type:${type}`);
        loader.abort();
      }

      frag.loader = this._loaders[type] = new NetworkEngine(config);
      this._keyUrl = uri;
      this._keyData = null;

      let loaderContext: NetworkEngineContext,
        loaderConfig: NetworkEngineLoadOptions,
        loaderCallbacks: NetworkEngineCallbacks;

      loaderContext = {
        type: NetworkEngineContextType.KEY,
        id: null,
        loader: null,
        level: null,
        levelDetails: null,
        url: uri,
        frag: frag,
        responseType: 'arraybuffer'
      };

      // maxRetry is 0 so that instead of retrying the same key on the same variant multiple times,
      // key-loader will trigger an error and rely on stream-controller to handle retry logic.
      // this will also align retry logic with fragment-loader

      loaderConfig = {
        timeout: config.fragLoadingTimeOut,
        maxRetry: 0,
        retryDelay: config.fragLoadingRetryDelay,
        maxRetryDelay: config.fragLoadingMaxRetryTimeout
      };

      loaderCallbacks = {
        onSuccess: this._handleSuccess.bind(this),
        onError: this._handleError.bind(this),
        onTimeout: this._handleTimeout.bind(this)
      };

      frag.loader.load(loaderContext, loaderConfig, loaderCallbacks);
    } else if (this._keyData) {
      // we already loaded this key, return it
      decryptdata.key = this._keyData;
      this.hls.trigger(Event.KEY_LOADED, { frag: frag });
    }
  }

  private _handleSuccess (response, stats, context) {
    let frag = context.frag;
    this._keyData = frag.decryptdata.key = new Uint8Array(response.data);
    // detach fragment loader on load success
    frag.loader = undefined;
    this._loaders[frag.type] = undefined;
    this.hls.trigger(Event.KEY_LOADED, { frag: frag });
  }

  private _handleError (response, context) {
    let frag = context.frag,
      loader = frag.loader;
    if (loader) {
      loader.abort();
    }

    this._loaders[context.type] = undefined;
    this.hls.trigger(Event.ERROR, { type: ErrorType.NETWORK_ERROR, details: ErrorDetail.KEY_LOAD_ERROR, fatal: false, frag: frag, response: response });
  }

  private _handleTimeout (stats, context) {
    let frag = context.frag,
      loader = frag.loader;
    if (loader) {
      loader.abort();
    }

    this._loaders[context.type] = undefined;
    this.hls.trigger(Event.ERROR, { type: ErrorType.NETWORK_ERROR, details: ErrorDetail.KEY_LOAD_TIMEOUT, fatal: false, frag: frag });
  }
}
