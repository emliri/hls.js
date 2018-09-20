import { AlternateMediaTrack, AlternateMediaType, AlternateMediaSet, MediaVariantDetails, QualityLevel } from '../hls';
import { M3U8Parser } from '../m3u8/m3u8-parser';
import { logger } from '../utils/logger';

export function createTrackListsFromM3u8 (data: string, baseUrl: string, levels: QualityLevel[]): AlternateMediaSet {
  const audioGroups = levels.map(level => ({
    id: level.attrs['AUDIO'],
    codec: level.audioCodec
  }));

  let audioTracks: MediaTrackList = M3U8Parser.parseMasterPlaylistMedia(data, baseUrl, AlternateMediaType.AUDIO, audioGroups);
  let subtitleTracks: MediaTrackList = M3U8Parser.parseMasterPlaylistMedia(data, baseUrl, AlternateMediaType.SUBTITLES);

  if (audioTracks.length) {
    // check if we have found an audio track embedded in main playlist (audio track without URI attribute)
    let embeddedAudioFound = false;
    audioTracks.forEach(audioTrack => {
      if (!audioTrack.url) {
        embeddedAudioFound = true;
      }
    });

    // if no embedded audio track defined, but audio codec signaled in quality level,
    // we need to signal this main audio track this could happen with playlists with
    // alt audio rendition in which quality levels (main)
    // contains both audio+video. but with mixed audio track not signaled
    if (!embeddedAudioFound && levels[0].audioCodec && !levels[0].attrs['AUDIO']) {
      logger.log('audio codec signaled in quality level, but no embedded audio track signaled, create one');
      const embeddedAudioTrack = new MediaTrack(AlternateMediaType.AUDIO, null); // FIXME:
      audioTracks.unshift(embeddedAudioTrack);
    }
  }

  return {
    SUBTITLES: subtitleTracks,
    AUDIO: audioTracks
  };
}

export class MediaTrack implements AlternateMediaTrack {
  groupId: string = null;
  autoselect: boolean = false;
  default: boolean = false;
  forced: boolean = false;
  lang: string = null;
  name: string = null;

  url: string = null;

  details?: MediaVariantDetails
  audioCodec?: string
  subtitleCodec?: string

  constructor (
    public type: AlternateMediaType,
    public id: number
  ) {

  }
}

export class MediaTrackList extends Array<MediaTrack> {
  constructor (array: MediaTrack[]) {
    super();
    array.forEach((track) => this.push(track));
  }
}
