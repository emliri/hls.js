import { MediaVariantDetails } from '../hls';
import { MediaFragment } from './media-fragment';
import { M3U8Parser } from './m3u8-parser';
import { NetworkEngineContextType } from '../network/network-engine';

export function createVariantFromM3u8 (
  data: string, url: string,
  levelId: number,
  levelType: MediaVariantType,
  levelUrlId: number): MediaVariant {
  const levelDetails = M3U8Parser.parseLevelPlaylist(data, url, levelId, levelType, levelUrlId);

  return levelDetails;
}
export enum MediaVariantType {
  MAIN = 'main',
  AUDIO = 'audio',
  SUBTITLE = 'subtitle'
}

export class MediaVariant implements MediaVariantDetails {
  PTSKnown: boolean = false;
  fragments: MediaFragment[] = [];
  url: string;
  live: boolean = true;
  averagetargetduration: number = 0;
  targetduration: number = 0;
  totalduration: number = 0;
  startCC: number = 0;
  endCC: number = 0;
  startSN: number = 0;
  endSN: number = 0;
  startTimeOffset: number | null = null;
  tload: number | null;
  type: string | null = null;
  version: number | null = null;
  initSegment: MediaFragment | null = null;
  needSidxRanges: boolean = false;

  audioGroupIds: string[];
  subtitleGroupIds: string[];

  constructor (baseUrl: string) {
    this.url = baseUrl;
  }

  get hasProgramDateTime (): boolean {
    return !!(this.fragments[0] && Number.isFinite(this.fragments[0].programDateTime));
  }
}

export class MediaVariantList extends Array<MediaVariant> {
  constructor (array: MediaVariant[]) {
    super();
    array.forEach((track) => this.push(track));
  }
}
