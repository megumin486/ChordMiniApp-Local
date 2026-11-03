/** @type {import('next').NextConfig} */
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
});

// connect-src keeps only the origins this local build genuinely calls out to.
// Removed during the Phase 5 tightening (2026-11-01): ad/analytics domains
// (doubleclick, googlesyndication, googleadservices and friends), the YouTube
// data domains, quicktube, api.genius, the three Vercel domains,
// jsdelivr/unpkg, vocalremover, workers.dev and dltkk, none of which had any
// product reference under src/.
// Note img-src / frame-src / script-src were left untouched and still carry
// their own YouTube/Google entries.
const connectSrcValues = Array.from(new Set([
  "'self'",
  'blob:',
  // smplr soundfont library (loaded with fetch as a midi-js soundfont):
  // src/services/chord-playback/soundfont/smplrLoader.ts → gleitzKitUrl
  'https://gleitz.github.io',
  // smplr violin loop data (loadLoopData: true) -> getGoldstSoundfontLoopsUrl
  'https://goldst.dev',
]));

const contentSecurityPolicy = [
  `connect-src ${connectSrcValues.join(' ')}`,
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "frame-src 'self' https://www.youtube.com https://youtube.com https://www.youtube-nocookie.com https://s3.us-east-1.amazonaws.com https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://www.google.com https://www.recaptcha.net",
  "img-src 'self' data: https://*.googleapis.com https://*.youtube.com https://*.ytimg.com https://*.ggpht.com https://*.google.com https://*.doubleclick.net https://*.googlesyndication.com https://pagead2.googlesyndication.com",
  "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval' https://www.youtube.com https://www.youtube-nocookie.com https://*.googleapis.com https://*.google.com https://www.gstatic.com https://www.recaptcha.net https://*.doubleclick.net https://*.googlesyndication.com https://gleitz.github.io https://cdn.jsdelivr.net https://unpkg.com",
].join('; ');


const nextConfig = {
  // Enable standalone output for Docker deployments
  // Transpile ES modules that need to be converted to CommonJS
  transpilePackages: [],

  // Environment variables
  env: {
    CUSTOM_KEY: process.env.CUSTOM_KEY,
  },

  // Modern JavaScript compilation
  compiler: {
    // Remove console.logs in production
    removeConsole: process.env.NODE_ENV === 'production' ? {
      exclude: ['error', 'warn']
    } : false,
  },

  // Experimental features
  experimental: {
    nextScriptWorkers: false,
  },

  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.googleapis.com',
      },
      {
        protocol: 'https',
        hostname: '**.ggpht.com',
      },
      {
        protocol: 'https',
        hostname: 'yt3.ggpht.com',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 's3.us-east-1.amazonaws.com',
      }
    ],
    qualities: [60, 75, 85, 90, 100],
  },



  // Headers for security and CORS
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET, POST, PUT, DELETE, OPTIONS',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type, Authorization, X-Firebase-AppCheck',
          },
        ],
      },
      {
        // Enhanced CORS and CSP headers to handle YouTube embeds and Google Ads
        source: '/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET, POST, PUT, DELETE, OPTIONS',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type, Authorization, X-Requested-With, X-Firebase-AppCheck',
          },
          {
            key: 'Content-Security-Policy',
            value: contentSecurityPolicy,
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'unsafe-none',
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups',
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'cross-origin',
          },
        ],
      },
    ];
  },

  // Redirects
  async redirects() {
    return [
      {
        source: '/github',
        destination: 'https://github.com/ptnghia-j/ChordMiniApp',
        permanent: false,
      },
    ];
  },

  // Webpack configuration
  webpack: (config, { dev, isServer }) => {
    // Performance optimizations
    if (!dev && !isServer) {
      // Simplified bundle splitting strategy to reduce fragmentation
      config.optimization.splitChunks = {
        chunks: 'all',
        minSize: 30000, // Increased from 10000 to align with webpack defaults
        cacheGroups: {
          // Framework: React core (priority 60)
          'framework-react': {
            test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            name: 'framework-react',
            chunks: 'all',
            priority: 60,
            enforce: true,
          },
          // Framework: Next.js (priority 55)
          'framework-next': {
            test: /[\\/]node_modules[\\/]next[\\/]/,
            name: 'framework-next',
            chunks: 'all',
            priority: 55,
            enforce: true,
          },
          // Vendor: UI libraries (priority 35)
          'vendor-ui': {
            test: /[\\/]node_modules[\\/](@heroui|@headlessui\/react|@heroicons|@radix-ui\/|react-icons)[\\/]/,
            name: 'vendor-ui',
            chunks: 'all',
            priority: 35,
          },
          // Vendor: Audio libraries (priority 33)
          'vendor-audio': {
            test: /[\\/]node_modules[\\/](tone|smplr|music-metadata)[\\/]/,
            name: 'vendor-audio',
            chunks: 'all',
            priority: 33,
          },
          // Vendor: State management (priority 32)
          'vendor-state': {
            test: /[\\/]node_modules[\\/](@tanstack\/react-query|zustand)[\\/]/,
            name: 'vendor-state',
            chunks: 'all',
            priority: 32,
          },
          // Styles: CSS files (priority 20)
          styles: {
            name: 'styles',
            test: /\.css$/,
            chunks: 'all',
            enforce: true,
            priority: 20,
          },
          // Vendors: Catchall for remaining node_modules (priority 10)
          vendors: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            chunks: 'all',
            priority: 10,
            minChunks: 2,
          },
        },
      };

      // Enhanced tree shaking optimization
      config.optimization.usedExports = true;
      config.optimization.sideEffects = false;
      config.optimization.providedExports = true;

      // Module concatenation for better performance
      config.optimization.concatenateModules = true;

      // Fix source map generation issues for production
      config.devtool = 'hidden-source-map'; // Use hidden source maps to avoid browser warnings

      // Ensure proper source map handling for webpack chunks
      config.output = config.output || {};
      config.output.devtoolModuleFilenameTemplate = function (info) {
        const rel = info.resourcePath.replace(process.cwd(), '.');
        return `webpack://chordmini/${rel}`;
      };
      config.output.devtoolFallbackModuleFilenameTemplate = function (info) {
        return `webpack://chordmini/${info.resourcePath}?${info.hash}`;
      };
    } else {
      // Development source maps
      config.devtool = 'eval-source-map';
    }

    // Handle audio files
    config.module.rules.push({
      test: /\.(mp3|wav|ogg|flac)$/,
      use: {
        loader: 'file-loader',
        options: {
          publicPath: '/_next/static/audio/',
          outputPath: 'static/audio/',
        },
      },
    });

    // Handle ES modules properly
    config.resolve.extensionAlias = {
      '.js': ['.js', '.ts'],
      '.jsx': ['.jsx', '.tsx'],
    };

    return config;
  },

  // Create the self-contained server bundle copied by the production Dockerfile.
  // Vercel ignores this setting, so it remains compatible with Vercel deployments.
  output: 'standalone',

  // Disable x-powered-by header
  poweredByHeader: false,

  // Compression
  compress: true,

  // Generate ETags for caching
  generateEtags: true,

  // Page extensions
  pageExtensions: ['ts', 'tsx', 'js', 'jsx', 'md', 'mdx'],

  // Trailing slash configuration
  trailingSlash: false,

  // React strict mode
  reactStrictMode: true,

  // Source map configuration - Fixed for production deployment
  productionBrowserSourceMaps: true, // Enable source maps in production for better debugging



  // TypeScript configuration
  typescript: {
    // Dangerously allow production builds to successfully complete even if
    // your project has TypeScript errors.
    ignoreBuildErrors: false,
  },

  // NOTE: ESLint configuration moved to eslint.config.mjs (Next.js 16+)
  // Use `next lint` CLI options instead: https://nextjs.org/docs/app/api-reference/cli/next#next-lint-options
};

module.exports = withBundleAnalyzer(nextConfig);
