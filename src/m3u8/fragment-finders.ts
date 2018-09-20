import BinarySearch from '../utils/binary-search';
import { MediaFragment } from './media-fragment';

/**
 * Returns first fragment whose endPdt value exceeds the given PDT.
 * @param {Array<MediaFragment>} fragments - The array of candidate fragments
 * @param {number|null} [pdtVal = null] - The PDT value which must be exceeded
 * @param {number} [maxFragLookUpTolerance = 0] - The amount of time that a fragment's start/end can be within in order to be considered contiguous
 * @returns {*|null} fragment - The best matching fragment
 */
export function findFragmentByPDT (fragments: MediaFragment[], pdtVal: number, maxFragLookUpTolerance: number): MediaFragment {
  if (!Array.isArray(fragments) || !fragments.length || !Number.isFinite(pdtVal)) {
    return null;
  }

  // if less than start
  if (pdtVal < fragments[0].programDateTime) {
    return null;
  }

  if (pdtVal >= fragments[fragments.length - 1].endProgramDateTime) {
    return null;
  }

  maxFragLookUpTolerance = maxFragLookUpTolerance || 0;
  for (let seg = 0; seg < fragments.length; ++seg) {
    let frag = fragments[seg];
    if (isPdtWithinToleranceTest(frag, pdtVal, maxFragLookUpTolerance)) {
      return frag;
    }
  }

  return null;
}

/**
 * Finds a fragment based on the SN of the previous fragment; or based on the needs of the current buffer.
 * This method compensates for small buffer gaps by applying a tolerance to the start of any candidate fragment, thus
 * breaking any traps which would cause the same fragment to be continuously selected within a small range.
 * @param {*} fragPrevious - The last frag successfully appended
 * @param {Array<MediaFragment>} fragments - The array of candidate fragments
 * @param {number} [bufferEnd = 0] - The end of the contiguous buffered range the playhead is currently within
 * @param {number} maxFragLookUpTolerance - The amount of time that a fragment's start/end can be within in order to be considered contiguous
 * @returns {*} foundFrag - The best matching fragment
 */

function makeCompareFragmentFn (bufferEnd, maxFragLookUpTolerance) {
  return (fragment: MediaFragment) => compareFragmentWithTolerance(fragment, bufferEnd, maxFragLookUpTolerance);
}

export function findFragmentByPTS (fragPrevious: MediaFragment, fragments: MediaFragment[],
  bufferEnd: number = 0, maxFragLookUpTolerance: number = 0): MediaFragment {
  const fragNext = fragPrevious ? fragments[fragPrevious.sn - fragments[0].sn + 1] : null;
  // Prefer the next fragment if it's within tolerance
  if (fragNext && !compareFragmentWithTolerance(fragNext, bufferEnd, maxFragLookUpTolerance)) {
    return fragNext;
  }
  return BinarySearch.search(fragments, makeCompareFragmentFn(bufferEnd, maxFragLookUpTolerance));
}

/**
 * The compare function used by the findFragmentBySn's BinarySearch to look for the best match to the current buffer conditions.
 * @param {MediaFragment} candidate - The fragment to test
 * @param {number} [bufferEnd = 0] - The end of the current buffered range the playhead is currently within
 * @param {number} [maxFragLookUpTolerance = 0] - The amount of time that a fragment's start can be within in order to be considered contiguous
 * @returns {number} - 0 if it matches, 1 if too low, -1 if too high
 */
export function compareFragmentWithTolerance (candidate: MediaFragment, bufferEnd: number = 0, maxFragLookUpTolerance: number = 0): number {
  // offset should be within fragment boundary - config.maxFragLookUpTolerance
  // this is to cope with situations like
  // bufferEnd = 9.991
  // frag[Ø] : [0,10]
  // frag[1] : [10,20]
  // bufferEnd is within frag[0] range ... although what we are expecting is to return frag[1] here
  //              frag start               frag start+duration
  //                  |-----------------------------|
  //              <--->                         <--->
  //  ...--------><-----------------------------><---------....
  // previous frag         matching fragment         next frag
  //  return -1             return 0                 return 1
  // logger.log(`level/sn/start/end/bufEnd:${level}/${candidate.sn}/${candidate.start}/${(candidate.start+candidate.duration)}/${bufferEnd}`);
  // Set the lookup tolerance to be small enough to detect the current segment - ensures we don't skip over very small segments
  let candidateLookupTolerance = Math.min(maxFragLookUpTolerance, candidate.duration + (candidate.deltaPTS ? candidate.deltaPTS : 0));
  if (candidate.start + candidate.duration - candidateLookupTolerance <= bufferEnd) {
    return 1;
  } else if (candidate.start - candidateLookupTolerance > bufferEnd && candidate.start) {
    // if maxFragLookUpTolerance will have negative value then don't return -1 for first element
    return -1;
  }

  return 0;
}

/**
 * The test function used by the findFragmentByPdt's BinarySearch to look for the best match to the current buffer conditions.
 * This function tests the candidate's program date time values, as represented in Unix time
 * @param {MediaFragment} candidate - The fragment to test
 * @param {number} [pdtBufferEnd = 0] - The Unix time representing the end of the current buffered range
 * @param {number} [maxFragLookUpTolerance = 0] - The amount of time that a fragment's start can be within in order to be considered contiguous
 * @returns {boolean} True if contiguous, false otherwise
 */
export function isPdtWithinToleranceTest (candidate: MediaFragment, pdtBufferEnd: number, maxFragLookUpTolerance: number): boolean {
  let candidateLookupTolerance = Math.min(maxFragLookUpTolerance, candidate.duration + (candidate.deltaPTS ? candidate.deltaPTS : 0)) * 1000;
  return candidate.endProgramDateTime - candidateLookupTolerance > pdtBufferEnd;
}
