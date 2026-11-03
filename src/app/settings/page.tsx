'use client';

import React from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import Navigation from '@/components/common/Navigation';
import { Card, CardBody, Switch, Tabs, Tab, Divider } from '@heroui/react';
import { FiSettings, FiLock, FiMoon, FiShield, FiDatabase } from 'react-icons/fi';
import type { ReactNode } from 'react';

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

export default function SettingsPage() {
  const { theme, toggleTheme } = useTheme();

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
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary-50 dark:bg-primary-900/20">
                          <FiMoon className="w-4 h-4 text-blue" />
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Dark Mode</h4>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Toggle between light and dark themes</p>
                        </div>
                      </div>
                      <Switch
                        isSelected={theme === 'dark'}
                        onValueChange={toggleTheme}
                        color="primary"
                        size="sm"
                      />
                    </div>
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