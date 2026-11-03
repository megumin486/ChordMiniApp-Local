'use client';

import React from 'react';
import Navigation from '@/components/common/Navigation';

/**
 * Privacy page — local-only build.
 *
 * Nothing is uploaded to a cloud service, so this page describes what actually
 * stays on the machine (SQLite cache, local audio directory) and the single
 * optional outbound requests (soundfont assets for chord playback only).
 */

const PrivacyPage: React.FC = () => {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-dark-bg transition-colors duration-300">
      <Navigation />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">

        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">
            Privacy Policy
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300">
            Local-only build
          </p>
        </div>

        {/* Introduction */}
        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
            Introduction
          </h2>
          <div className="space-y-4 text-gray-700 dark:text-gray-300">
            <p>
              This build of ChordMini runs entirely on your own computer. There is no account,
              no sign-in, and no API key. Your audio never leaves this machine.
            </p>
          </div>
        </div>

        {/* What stays local */}
        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
            What Stays On Your Machine
          </h2>
          <div className="space-y-4 text-gray-700 dark:text-gray-300">
            <ul className="space-y-2">
              <li>• <strong>Audio files you upload</strong> — written once to the local audio store
                (content-addressed, pruned by a size budget and TTL), never uploaded anywhere.</li>
              <li>• <strong>Analysis results</strong> — beat grids, chords, key detection and Roman
                numeral analysis are cached in a local SQLite database so repeated analysis is instant.</li>
              <li>• <strong>Your preferences</strong> — theme and UI settings are kept in browser storage.</li>
            </ul>
            <p>
              You can clear the cached analyses and stored audio from the Analyze page at any time.
            </p>
          </div>
        </div>

        {/* Network access */}
        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
            Network Access
          </h2>
          <div className="space-y-4 text-gray-700 dark:text-gray-300">
            <ul className="space-y-2">
              <li>• <strong>Local analysis service</strong> — requests go only to the Python backend
                on <code>127.0.0.1:5001</code>.</li>
              <li>• <strong>Instrument samples (playback only)</strong> — whenever a sound is played
                (chord playback, the in-app mini-games), the browser fetches soundfont files from{' '}
                <code>gleitz.github.io</code> / <code>goldst.dev</code>. Only those static assets are
                requested; no audio, filename or analysis result is sent.</li>
              <li>• <strong>Lyrics lookup — removed.</strong> The LRCLIB integration was taken out of
                this build, so no song title, artist or lyric data ever leaves this machine.</li>
            </ul>
            <p>
              No analytics, telemetry, error reporting or advertising services are used.
            </p>
          </div>
        </div>

        {/* Changelog of this build */}
        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
            Removed Third-Party Services
          </h2>
          <div className="space-y-4 text-gray-700 dark:text-gray-300">
            <p>
              Earlier versions of ChordMini depended on YouTube, Firebase, Google Gemini, Music.ai
              and Google Cloud. Those integrations have been removed from this build: key detection
              and Roman numeral analysis now use a local rule engine, and storage uses SQLite plus
              the local audio directory.
            </p>
          </div>
        </div>

        {/* Contact */}
        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
            Questions
          </h2>
          <div className="space-y-4 text-gray-700 dark:text-gray-300">
            <p>
              Because nothing leaves your machine, there is no server-side data to request or delete.
              For questions about the original research project, contact the ChordMini maintainers.
            </p>
          </div>
        </div>

      </div>
    </div>
  );
};

export default PrivacyPage;