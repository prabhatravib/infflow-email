import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from '@/components/ui/sidebar';
import { ConsoleLogDownloadButton } from '@/components/ui/console-log-download-button';
import { navigationConfig, bottomNavItems } from '@/config/navigation';
import React, { useMemo, useState } from 'react';
import { useSession } from '@/lib/auth-client';

import { useSidebar } from '@/components/ui/sidebar';
import { CreateEmail } from '../create/create-email';
import { PencilCompose, X } from '../icons/icons';
import { useBilling } from '@/hooks/use-billing';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import { useAIFullScreen } from './ai-sidebar';
import { useStats } from '@/hooks/use-stats';
import { HexaPanel } from './hexa-panel';
import { useLocation } from 'react-router';

import { m } from '@/paraglide/messages';
import { FOLDERS } from '@/lib/utils';
import { NavUser } from './nav-user';
import { NavMain } from './nav-main';
import { useQueryState } from 'nuqs';

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { isPro, isLoading } = useBilling();
  const [showUpgrade, setShowUpgrade] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('hideUpgradeCard') !== 'true';
    }
    return true;
  });
  const [, setPricingDialog] = useQueryState('pricingDialog');

  const { isFullScreen } = useAIFullScreen();

  const { data: stats } = useStats();

  const location = useLocation();
  const { data: session } = useSession();
  const { currentSection, navItems } = useMemo(() => {
    // Find which section we're in based on the pathname
    const section = Object.entries(navigationConfig).find(([, config]) =>
      location.pathname.startsWith(config.path),
    );

    const currentSection = section?.[0] || 'mail';
    if (navigationConfig[currentSection]) {
      const items = [...navigationConfig[currentSection].sections];

      if (currentSection === 'mail' && stats && stats.length) {
        if (items[0]?.items[0]) {
          items[0].items[0].badge =
            stats.find((stat) => stat.label?.toLowerCase() === FOLDERS.INBOX)?.count ?? 0;
        }
        if (items[0]?.items[3]) {
          items[0].items[3].badge =
            stats.find((stat) => stat.label?.toLowerCase() === FOLDERS.SENT)?.count ?? 0;
        }
      }

      return { currentSection, navItems: items };
    } else {
      return {
        currentSection: '',
        navItems: [],
      };
    }
  }, [location.pathname, stats]);

  const showComposeButton = currentSection === 'mail';
  const { state } = useSidebar();

  return (
    <div>
      {!isFullScreen && (
        <Sidebar
          collapsible="icon"
          {...props}
          className={`bg-sidebar dark:bg-sidebar flex h-screen select-none flex-col items-center ${state === 'collapsed' ? '' : ''} pb-2`}
        >
          <SidebarHeader
            className={`relative top-2.5 flex flex-col gap-2 ${state === 'collapsed' ? 'px-2' : 'md:px-4'}`}
          >
            {session && <NavUser />}

            {showComposeButton && (
              <div>
                <ComposeButton />
              </div>
            )}
          </SidebarHeader>
          <SidebarContent
            // flex-initial, not the default flex-1: the folder list takes only
            // the height it needs so the voice pane below can have the rest,
            // while still shrinking and scrolling in a short window.
            className={`scrollbar scrollbar-w-1 scrollbar-thumb-accent/40 scrollbar-track-transparent hover:scrollbar-thumb-accent scrollbar-thumb-rounded-full flex-initial overflow-x-hidden py-0 pt-0 ${state !== 'collapsed' ? 'mt-5 md:px-4' : 'px-2'}`}
          >
            <div className="flex-1 py-0">
              <NavMain items={navItems} />
            </div>
          </SidebarContent>

          {/* Zero Pro upgrade popup removed */}

          {state !== 'collapsed' && (
            <div className="flex min-h-0 flex-1 flex-col px-0 pb-2 md:px-4">
              <HexaPanel />
            </div>
          )}

          <SidebarFooter className={`px-0 pb-0 ${state === 'collapsed' ? 'md:px-2' : 'md:px-4'}`}>
            {/* The log download sits on the settings row, not in the voice pane
                header: it is a debugging affordance rather than a voice control.
                Hidden while collapsed, where the rail is only wide enough for
                the icon nav — the same rule the voice pane above follows. The
                button's `mb-2` matches the nav group's own bottom padding so
                the two centres line up. */}
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <NavMain items={bottomNavItems} />
              </div>
              {state !== 'collapsed' && <ConsoleLogDownloadButton className="mb-2" />}
            </div>
          </SidebarFooter>
        </Sidebar>
      )}
    </div>
  );
}

function ComposeButton() {
  const { state } = useSidebar();
  const isMobile = useIsMobile();

  const [dialogOpen, setDialogOpen] = useQueryState('isComposeOpen');
  const [, setDraftId] = useQueryState('draftId');
  const [, setTo] = useQueryState('to');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const [, setMode] = useQueryState('mode');

  const handleOpenChange = async (open: boolean) => {
    if (!open) {
      setDialogOpen(null);
    } else {
      setDialogOpen('true');
    }
    setDraftId(null);
    setTo(null);
    setActiveReplyId(null);
    setMode(null);
  };
  return (
    <Dialog open={!!dialogOpen} onOpenChange={handleOpenChange}>
      <DialogTitle></DialogTitle>
      <DialogDescription></DialogDescription>

      <DialogTrigger asChild>
        <button className="relative mb-1.5 inline-flex h-8 w-full items-center justify-center gap-1 self-stretch overflow-hidden rounded-lg border border-gray-200 bg-[#006FFE] text-black dark:border-none dark:text-white">
          {state === 'collapsed' && !isMobile ? (
            <PencilCompose className="mt-0.5 fill-white text-black" />
          ) : (
            <div className="flex items-center justify-center gap-2.5 pl-0.5 pr-1">
              <PencilCompose className="fill-white" />
              <div className="justify-start text-sm leading-none text-white">
                {m['common.commandPalette.commands.newEmail']()}
              </div>
            </div>
          )}
        </button>
      </DialogTrigger>

      <DialogContent className="h-screen w-screen max-w-none border-none bg-[#FAFAFA] p-0 shadow-none dark:bg-[#141414]">
        <CreateEmail />
      </DialogContent>
    </Dialog>
  );
}
