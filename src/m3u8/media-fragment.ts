import * as URLToolkit from 'url-toolkit';

import { LevelKey } from './level-key';
import { NetworkEngine, NetworkEngineContextType } from '../network/network-engine';
import { MediaVariantType } from './media-variant';

export enum MediaFragmentElementaryStreamType {
  AUDIO = 'audio',
  VIDEO = 'video',
  TEXT = 'text'
}

export type MediaFragmentDecryptData = {
  uri: string,
  key: Uint8Array,
  iv: Uint8Array,
  method: string
};

export type MediaFragmentElementaryStreamMap = { [t in MediaFragmentElementaryStreamType]: boolean };

export type MediaFragmentByteRange = [number, number];

export class MediaFragment {
  private _url: string | null;
  private _byteRange: MediaFragmentByteRange | null;
  private _decryptdata: MediaFragmentDecryptData;
  private _elementaryStreams: MediaFragmentElementaryStreamMap;

  public readonly tagList: string[][] = [];
  public readonly programDateTime: number | null;

  data: ArrayBuffer;

  deltaPTS: number;
  startPTS: number;
  endPTS: number;
  startDTS: number;
  endDTS: number;
  maxStartPTS: number;

  loaded: number;
  backtracked: boolean;
  dropped: boolean;

  rawProgramDateTime: string | null = null;
  lastByteRangeEndOffset: number;
  rawByteRange: string;
  baseurl: string;
  relurl: string;
  duration: number;
  levelkey: LevelKey;
  sn: number; // | string;
  title: string;
  start: number;
  level: number;
  cc: number;
  urlId: number;

  type: MediaVariantType;

  loader: NetworkEngine;

  constructor () {
    this._url = null;
    this._byteRange = null;
    this._decryptdata = null;
    this._elementaryStreams = {
      [MediaFragmentElementaryStreamType.AUDIO]: false,
      [MediaFragmentElementaryStreamType.VIDEO]: false,
      [MediaFragmentElementaryStreamType.TEXT]: false
    };
  }

  static get ElementaryStreamTypes () {
    return MediaFragmentElementaryStreamType;
  }

  get url (): string {
    if (!this._url && this.relurl) {
      this._url = URLToolkit.buildAbsoluteURL(this.baseurl, this.relurl, { alwaysNormalize: true });
    }

    return this._url;
  }

  set url (value: string) {
    this._url = value;
  }

  get byteRange (): MediaFragmentByteRange | null {
    if (!this.rawByteRange) {
      return null;
    }

    if (!this._byteRange) {
      this._parseByteRange();
    }

    return this._byteRange;
  }

  get byteRangeStartOffset (): number | null {
    return this.byteRange ? this.byteRange[0] : null;
  }

  get byteRangeEndOffset (): number | null {
    return this.byteRange ? this.byteRange[1] : null;
  }

  get decryptdata (): MediaFragmentDecryptData {
    if (!this._decryptdata) {
      this._decryptdata = this._createDecryptDataFromLevelkey(this.levelkey, this.sn);
    }

    return this._decryptdata;
  }

  get endProgramDateTime (): number {
    if (!Number.isFinite(this.programDateTime)) {
      return null;
    }

    let duration = !Number.isFinite(this.duration) ? 0 : this.duration;

    return this.programDateTime + (duration * 1000);
  }

  get encrypted (): boolean {
    return !!((this.decryptdata && this.decryptdata.uri !== null) && (this.decryptdata.key === null));
  }

  getKey (): string {
    return `${this.type}_${this.level}_${this.urlId}_${this.sn}`;
  }

  /**
   * @param {ElementaryStreamType} type
   */
  addElementaryStream (type: MediaFragmentElementaryStreamType) {
    this._elementaryStreams[type] = true;
  }

  /**
   * @param {ElementaryStreamType} type
   */
  hasElementaryStream (type: MediaFragmentElementaryStreamType): boolean {
    return this._elementaryStreams[type] === true;
  }

  /**
   * Utility method for parseLevelPlaylist to create an initialization vector for a given segment
   * @returns {Uint8Array}
   */
  private _createInitializationVector (segmentNumber): Uint8Array {
    let uint8View = new Uint8Array(16);

    for (let i = 12; i < 16; i++) {
      uint8View[i] = (segmentNumber >> 8 * (15 - i)) & 0xff;
    }

    return uint8View;
  }

  /**
   * Utility method for parseLevelPlaylist to get a fragment's decryption data from the currently parsed encryption key data
   * @param levelkey - a playlist's encryption info
   * @param segmentNumber - the fragment's segment number
   * @returns {*} - an object to be applied as a fragment's decryptdata
   */
  private _createDecryptDataFromLevelkey (levelkey: LevelKey, segmentNumber): MediaFragmentDecryptData {
    let decryptdata: any = levelkey;

    if (levelkey && levelkey.method && levelkey.uri && !levelkey.iv) {
      decryptdata = new LevelKey();
      decryptdata.method = levelkey.method;
      decryptdata.baseuri = (levelkey as any).baseuri;
      decryptdata.reluri = (levelkey as any).reluri;
      decryptdata.iv = this._createInitializationVector(segmentNumber);
    }

    return decryptdata;
  }

  private _parseByteRange () {
    const byteRange: MediaFragmentByteRange = [0, 0];

    if (!this.rawByteRange) {
      return;
    }

    const params = this.rawByteRange.split('@', 2);
    if (params.length === 1) {
      const lastByteRangeEndOffset = this.lastByteRangeEndOffset;
      byteRange[0] = lastByteRangeEndOffset || 0;
    } else {
      byteRange[0] = parseInt(params[1]);
    }
    byteRange[1] = parseInt(params[0]) + byteRange[0];
    this._byteRange = byteRange;
  }
}
