// replace by query-param package
function getURLParam(sParam, defaultValue) {
  let sPageURL = window.location.search.substring(1);
  let sURLVariables = sPageURL.split('&');
  for (let i = 0; i < sURLVariables.length; i++) {
    let sParameterName = sURLVariables[i].split('=');
    if (sParameterName[0] == sParam)
    {return 'undefined' == sParameterName[1] ? undefined : 'false' == sParameterName[1] ? false : sParameterName[1];}

  }
  return defaultValue;
}

function getDemoConfigPropOrDefault(propName, defaultVal) {
  return typeof demoConfig[propName] !== 'undefined' ? demoConfig[propName] : defaultVal;
}

const testStreams = require('../tests/test-streams');
const defaultTestStreamUrl = testStreams['sintel'].url;
const sourceURL = decodeURIComponent(getURLParam('src', defaultTestStreamUrl))

let demoConfig = getURLParam('demoConfig', null)
if (demoConfig) {
  demoConfig = JSON.parse(atob(demoConfig))
} else {
  demoConfig = {}
}

/*
let enableStreaming = getDemoConfigPropOrDefault('enableStreaming', true);
let autoRecoverError = getDemoConfigPropOrDefault('autoRecoverError', true);
let enableWorker = getDemoConfigPropOrDefault('enableWorker', true);
let levelCapping = getDemoConfigPropOrDefault('levelCapping', -1);
let limitMetrics = getDemoConfigPropOrDefault('limitMetrics', -1);
let defaultAudioCodec = getDemoConfigPropOrDefault('defaultAudioCodec', undefined);
let widevineLicenseUrl = getDemoConfigPropOrDefault('widevineLicenseURL', undefined);
let dumpfMP4 = getDemoConfigPropOrDefault('dumpfMP4', false);
*/

const video = document.getElementById('media');

const hls = new window.Hls();

hls.attachMedia(video);

hls.loadSource(sourceURL);

document.getElementById('version').innerHTML = Hls.version;
