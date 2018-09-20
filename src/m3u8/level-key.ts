import * as URLToolkit from 'url-toolkit';

export class LevelKey {
  method: string;
  key: Uint8Array;
  iv: Uint8Array;

  reluri: string;
  baseuri: string;

  private _uri: string = null;

  constructor () {
    this.method = null;
    this.key = null;
    this.iv = null;
    this._uri = null;
  }

  get uri () {
    if (!this._uri && this.reluri) {
      this._uri = URLToolkit.buildAbsoluteURL(this.baseuri, this.reluri, { alwaysNormalize: true });
    }

    return this._uri;
  }
}
