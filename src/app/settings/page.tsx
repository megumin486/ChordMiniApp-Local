'use client';

import React from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import Navigation from '@/components/common/Navigation';
import { Card, CardBody, Tabs, Tab, Divider } from '@heroui/react';
import { FiSettings, FiLock, FiMoon, FiShield, FiDatabase, FiMonitor, FiSun } from 'react-icons/fi';
import type { ReactNode } from 'react';
import type { ThemePreference } from '@/utils/themePreference';

/**
 * Settings page — local-only build.
 *
 * The API Keys tab was removed: nothing in this build talks to a cloud service,
 * so there is no key to manage. The privacy tab now describes what actually
 * happens on this machine (SQLite cache + local audio store).
 */

interface PrivacyItemProps {
  icon: ReactNode;
  iconBg: string;
  title: string;
  description: string;
}

const PrivacyItem = ({ icon, iconBg, title, description }: PrivacyItemProps) => (
  <div className="flex items-start gap-3">
    <div className={`p-2 rounded-lg ${iconBg}`}>{icon}</div>
    <div>
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
      <p className="text-xs text-gray-500 dark:text-gray-400">{description}</p>
    </div>
  </div>
);

interface ThemeOption {
  key: ThemePreference;
  label: string;
  description: string;
  icon: ReactNode;
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    key: 'system',
    label: 'System',
    description: 'Follow this computer and switch automatically at sunset',
    icon: <FiMonitor className="w-4 h-4" />,
  },
  {
    key: 'light',
    label: 'Light',
    description: 'Always use the light theme',
    icon: <FiSun className="w-4 h-4" />,
  },
  {
    key: 'dark',
    label: 'Dark',
    description: 'Always use the dark theme',
    icon: <FiMoon className="w-4 h-4" />,
  },
];

export default function SettingsPage() {
  const { preference, setPreference } = useTheme();

  return (
    <div className="min-h-screen dark:bg-dark-bg">
      <Navigation />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2 text-foreground">Settings</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Manage your local preferences
          </p>
        </div>

        <div className="max-w-4xl mx-auto">
          <Tabs
            defaultSelectedKey="general"
            variant="underlined"
            color="success"
            classNames={{
              tabList: "gap-6 w-full relative rounded-none p-0 border-b border-divider",
              cursor: "w-full bg-success",
              tab: "max-w-fit px-0 h-12 group",
              tabContent: "text-gray-600 dark:text-gray-400 group-data-[selected=true]:text-success group-data-[selected=true]:font-semibold"
            }}
          >
            {/* General Tab */}
            <Tab
              key="general"
              title={
                <div className="flex items-center space-x-2">
                  <FiSettings className="w-4 h-4" />
                  <span>General</span>
                </div>
              }
            >
              <div className="space-y-4 pt-1">
                <Card shadow="sm" className="border border-gray-200 dark:border-gray-700">
                  <CardBody className="p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="p-2 rounded-lg bg-primary-50 dark:bg-primary-900/20">
                        <FiMoon className="w-4 h-4 text-blue" />
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Appearance</h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Choose a theme, or let it follow this computer
                        </p>
                      </div>
                    </div>

                    <div
                      role="group"
                      aria-label="Theme"
                      className="grid gap-2 sm:grid-cols-3"
                    >
                      {THEME_OPTIONS.map(option => {
                        const selected = preference === option.key;
                        return (
                          <button
                            key={option.key}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setPreference(option.key)}
                            className={`flex items-start gap-2 rounded-lg border p-3 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-success ${
                              selected
                                ? 'border-success bg-success-50 dark:bg-success-900/20'
                                : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800'
                            }`}
                          >
                            <span
                              className={
                                selected
                                  ? 'mt-0.5 text-success'
                                  : 'mt-0.5 text-gray-500 dark:text-gray-400'
                              }
                            >
                              {option.icon}
                            </span>
                            <span>
                              <span
                                className={`block text-sm font-medium ${
                                  selected
                                    ? 'text-success'
                                    : 'text-gray-900 dark:text-white'
                                }`}
                              >
                                {option.label}
                              </span>
                              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                                {option.description}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                      The sun icon in the header switches between light and dark for now;
                      choose System again here to hand control back to the operating system.
                    </p>
                  </CardBody>
                </Card>
              </div>
            </Tab>

            {/* Privacy Tab */}
            <Tab
              key="privacy"
              title={
                <div className="flex items-center space-x-2">
                  <FiLock className="w-4 h-4" />
                  <span>Privacy</span>
                </div>
              }
            >
              <div className="space-y-4 pt-1">
                <Card shadow="sm" className="border border-gray-200 dark:border-gray-700">
                  <CardBody className="p-4 gap-4">
                    <PrivacyItem
                      icon={<FiShield className="w-4 h-4 text-success" />}
                      iconBg="bg-success-50 dark:bg-success-900/20"
                      title="No Accounts, No Keys"
                      description="This build runs entirely on this machine. There is no sign-in, no API key and no cloud service to configure."
                    />
                    <Divider />
                    <PrivacyItem
                      icon={<FiDatabase className="w-4 h-4 text-blue" />}
                      iconBg="bg-primary-50 dark:bg-primary-900/20"
                      title="Cache Data"
                      description="Analysis results and uploaded audio are cached in a local SQLite database and a local audio directory. You can clear them from the Analyze page."
                    />
                    <Divider />
                    <PrivacyItem
                      icon={<FiShield className="w-4 h-4 text-warning" />}
                      iconBg="bg-warning-50 dark:bg-warning-900/20"
                      title="Network Access"
                      description="Audio is never uploaded anywhere. Analysis requests only go to the local Python service on 127.0.0.1:5001."
                    />
                  </CardBody>
                </Card>
              </div>
            </Tab>
          </Tabs>
        </div>
      </div>
    </div>
  );
}