/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path');
const slsw = require('serverless-webpack');
const nodeExternals = require('webpack-node-externals');

module.exports = {
  context: __dirname,
  mode: slsw.lib.webpack.isLocal ? 'development' : 'production',
  entry: slsw.lib.entries,
  devtool: slsw.lib.webpack.isLocal ? 'eval-cheap-module-source-map' : 'source-map',
  resolve: {
    extensions: ['.js', '.mjs', '.json', '.ts'],
    symlinks: false,
    cacheWithContext: false,
    alias: {
      '@src': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
      '@events': path.resolve(__dirname, './events'),
    },
  },
  output: {
    libraryTarget: 'commonjs',
    path: path.join(__dirname, '.webpack'),
    filename: '[name].js',
  },
  target: 'node',
  // The bundle gets too big if we allow webpack to bundle all dependencies so
  // we remove them from the bundle (they get loaded in runtime).
  //
  // We are adding the common project to allowlist because otherwise it would not
  // be seen by the serverless-monorepo package.
  externals: [nodeExternals({
    allowlist: [new RegExp("@wallet-service/common*")],
  })],
  module: {
    rules: [
      // all files with a `.ts` or `.tsx` extension will be handled by `ts-loader`
      {
        test: /\.(tsx?)$/,
        loader: 'ts-loader',
        exclude: [
          [
            // The common module is not transpiled to javascript, so it needs
            // to be loaded with the ts-loader
            function(modulePath) {
              return /node_modules/.test(modulePath) &&
                     !/node_modules\/@wallet-service\/common/.test(modulePath);
            },
            path.resolve(__dirname, '.serverless'),
            path.resolve(__dirname, '.webpack'),
          ],
        ],
        options: {
          transpileOnly: true,
          experimentalWatchApi: true,
        },
      },
    ],
  },
  plugins: [],
};
