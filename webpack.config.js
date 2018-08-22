const glob = require("glob");
const path = require('path');
const webpack = require('webpack');
const {merge} = require('webpack-assembler');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;
const getGitVersion = require('git-tag-version');
const getGitCommitInfo = require('git-commit-info');

const pkgJson = require('./package.json');

/* Allow to customise builds through env-vars */
const env = process.env;

const addSubtitleSupport = !!env.SUBTITLE || !!env.USE_SUBTITLES;
const addAltAudioSupport = !!env.ALT_AUDIO || !!env.USE_ALT_AUDIO;
const addEMESupport = !!env.EME_DRM || !!env.USE_EME_DRM;
const runAnalyzer = !!env.ANALYZE;

const baseConfig = {
  mode: 'development',
  entry: './src/hls.ts',
  resolve: {
    // Add `.ts` as a resolvable extension.
    extensions: [".ts", ".js"]
  },
  module: {
    strictExportPresence: true,
    rules: [
      // all files with a `.ts` extension will be handled by `ts-loader`
      { test: /\.ts?$/, loader: "ts-loader" },
      { test: /\.js?$/, exclude: [/node_modules/], loader: "ts-loader" },
    ]
  },
  plugins: []
};

const demoConfig = merge(baseConfig, {
  name: 'demo',
  mode: 'development',
  entry: './demo/main',
  output: {
    filename: 'hls-demo.js',
    chunkFilename: '[name].js',
    sourceMapFilename: 'hls-demo.js.map',
    path: path.resolve(__dirname, 'dist'),
    publicPath: '/dist/',
    library: 'HlsDemo',
    libraryTarget: 'umd',
    libraryExport: 'default',
    globalObject: 'this'  // https://github.com/webpack/webpack/issues/6642#issuecomment-370222543
  },
  optimization: {
    minimize: false
  },
  plugins: [],
  devtool: 'source-map'
});

const unitTestsConfig = merge(baseConfig, {
  name: 'tests',
  mode: 'development',
  entry: glob.sync("./tests/unit/**/*.js"),
  output: {
    filename: 'hls-unit-tests.js',
    publicPath: '/dist/',
    path: path.resolve(__dirname, 'dist'),
    library: 'HlsUnitTests',
    libraryTarget: 'umd',
    libraryExport: 'default'
  },
  devtool: 'inline-source-map',
  plugins: getPluginsForConfig('main')
});

function getPluginsForConfig(type, minify = false) {
  // common plugins.

  const defineConstants = getConstantsForConfig(type);

  // console.log('DefinePlugin constants:', JSON.stringify(defineConstants, null, 2))

  const plugins = [
    new webpack.BannerPlugin({
      entryOnly: true,
      raw: true,
      banner: 'typeof window !== "undefined" &&' // SSR/Node.js guard
    }),
    new webpack.optimize.OccurrenceOrderPlugin(),
    new webpack.DefinePlugin(defineConstants),
    new webpack.ProvidePlugin({
      Number: [path.resolve('./src/polyfills/number'), 'Number']
    })
  ];

  if (runAnalyzer && !minify) {
    plugins.push(new BundleAnalyzerPlugin({
      analyzerMode: 'static',
      reportFilename: `bundle-analyzer-report.${type}.html`
    }));
  } else {
    // https://github.com/webpack-contrib/webpack-bundle-analyzer/issues/115
    plugins.push(new webpack.optimize.ModuleConcatenationPlugin());
  }

  return plugins;
}

function getConstantsForConfig (type) {

  // By default the "main" dists (hls.js & hls.min.js) are full-featured.
  return {
    __VERSION__: JSON.stringify(pkgJson.version || (getGitVersion() + '-' + getGitCommitInfo().shortCommit)),
    __USE_SUBTITLES__: JSON.stringify(type === 'main' || addSubtitleSupport),
    __USE_ALT_AUDIO__: JSON.stringify(type === 'main' || addAltAudioSupport),
    __USE_EME_DRM__: JSON.stringify(type === 'main' || addEMESupport)
  };
}

function getAliasesForLightDist () {

  const VOID_INJECTABLE_PATH = './void-injectable.ts';

  let aliases = {};

  if (!addEMESupport) {
    aliases = Object.assign({}, aliases, {
      './controller/eme-controller': VOID_INJECTABLE_PATH
    });
  }

  if (!addSubtitleSupport) {
    aliases = merge(aliases, {
      './utils/cues': VOID_INJECTABLE_PATH,
      './controller/timeline-controller': VOID_INJECTABLE_PATH,
      './controller/subtitle-track-controller': VOID_INJECTABLE_PATH,
      './controller/subtitle-stream-controller': VOID_INJECTABLE_PATH
    });
  }

  if (!addAltAudioSupport) {
    aliases = merge(aliases, {
      './controller/audio-track-controller': VOID_INJECTABLE_PATH,
      './controller/audio-stream-controller': VOID_INJECTABLE_PATH
    });
  }

  return aliases;
}

const multiConfig = [
  {
    name: 'debug',
    mode: 'development',
    output: {
      filename: 'hls.js',
      chunkFilename: '[name].js',
      sourceMapFilename: 'hls.js.map',
      path: path.resolve(__dirname, 'dist'),
      publicPath: '/dist/',
      library: 'Hls',
      libraryTarget: 'umd',
      libraryExport: 'default',
      globalObject: 'this'
    },
    plugins: getPluginsForConfig('main'),
    devtool: 'source-map'
  },
  {
    name: 'dist',
    mode: 'production',
    output: {
      filename: 'hls.min.js',
      chunkFilename: '[name].js',
      path: path.resolve(__dirname, 'dist'),
      publicPath: '/dist/',
      library: 'Hls',
      libraryTarget: 'umd',
      libraryExport: 'default',
      globalObject: 'this'
    },
    plugins: getPluginsForConfig('main', true),
    optimization: {
      minimize: true
    },
    devtool: 'source-map'
  },
  {
    name: 'light',
    mode: 'development',
    output: {
      filename: 'hls.light.js',
      chunkFilename: '[name].js',
      sourceMapFilename: 'hls.light.js.map',
      path: path.resolve(__dirname, 'dist'),
      publicPath: '/dist/',
      library: 'Hls',
      libraryTarget: 'umd',
      libraryExport: 'default',
      globalObject: 'this'
    },
    resolve: {
      alias: getAliasesForLightDist()
    },
    plugins: getPluginsForConfig('light'),
    devtool: 'source-map'
  },
  {
    name: 'light-dist',
    mode: 'production',
    output: {
      filename: 'hls.light.min.js',
      chunkFilename: '[name].js',
      path: path.resolve(__dirname, 'dist'),
      publicPath: '/dist/',
      library: 'Hls',
      libraryTarget: 'umd',
      libraryExport: 'default',
      globalObject: 'this'
    },
    resolve: {
      alias: getAliasesForLightDist()
    },
    plugins: getPluginsForConfig('light', true),
    optimization: {
      minimize: true
    },
    devtool: 'source-map'
  }
].map(config => merge(baseConfig, config));

multiConfig.push(demoConfig);
multiConfig.push(unitTestsConfig);

// webpack matches the --env arguments to a string; for example, --env.debug.min translates to { debug: true, min: true }
module.exports = (envArgs) => {
  let configs;

  if (!envArgs) {
    // If no arguments are specified, return every configuration
    configs = multiConfig;
  } else {
    // Find the first enabled config within the arguments array
    const enabledConfigName = Object.keys(envArgs).find(envName => envArgs[envName]);

    // Filter out config with name
    const enabledConfig = multiConfig.find(config => config.name === enabledConfigName);

    if (!enabledConfig) {
      console.error(`Couldn't find a valid config with the name "${enabledConfigName}". Known configs are: ${multiConfig.map(config => config.name).join(', ')}`);

      throw new Error('Hls.js webpack config: Invalid environment parameters');
    }

    configs = [enabledConfig, demoConfig, unitTestsConfig];
  }

  console.log(
    `Created webpack configuration for: ${configs.map(config => config.name).join(', ')}.\n`
  );

  // console.log('Resulting Webpack multi-config object:', JSON.stringify(configs, null, 4));

  return configs;
};
