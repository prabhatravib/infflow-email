import React, { useState, useMemo } from 'react';
import { PanelRightClose } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface EmailGroup {
  id: string;
  name: string;
  count: number;
  color: string;
  emails: Email[];
}

export interface Email {
  id: string;
  groupId: string;
  sender: string;
  subject: string;
  timestamp: Date;
}

interface EmailGroupsProps {
  groups: EmailGroup[];
  selectedGroupId: string | null;
  onGroupSelect: (groupId: string | null) => void;
  totalGroups: number;
  totalEmails: number;
  onCategorizeEmails?: () => Promise<void>;
  isCategorizing?: boolean;
  categorizationComplete?: boolean;
  pendingResults?: Map<string, string[]> | null;
  onClose?: () => void;
}

export function EmailGroups({
  groups,
  selectedGroupId,
  onGroupSelect,
  totalGroups,
  totalEmails,
  onCategorizeEmails,
  isCategorizing,
  categorizationComplete,
  pendingResults,
  onClose
}: EmailGroupsProps) {
  const isUpdating = !!(isCategorizing || (pendingResults && !categorizationComplete));

  return (
    <div className="h-full flex flex-col bg-[#f8fbff] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-white/80 border-[#b8d4f0]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-base font-semibold mb-0.5 text-[#2c5aa0]">Email Groups</h1>
            <p className="text-xs text-[#5a7ba8]">Your emails organized by topic</p>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close email groups panel"
              title="Close email groups"
              className="shrink-0 rounded-md p-1 text-[#4a8dd9] transition-colors hover:bg-[#e1f0ff]"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="mt-3 flex flex-col gap-2">
          {onCategorizeEmails && (
            <button
              onClick={onCategorizeEmails}
              disabled={isCategorizing}
              className={`w-full text-sm transition-colors hover:opacity-80 px-3 py-1.5 rounded-md border disabled:opacity-50 disabled:cursor-not-allowed ${
                categorizationComplete
                  ? 'text-green-600 bg-green-50 border-green-200 hover:bg-green-100'
                  : 'text-[#4a8dd9] bg-[#f0f7ff] border-[#b8d4f0] hover:bg-[#e1f0ff]'
              }`}
            >
              {isCategorizing
                ? 'Categorizing...'
                : categorizationComplete
                  ? 'Categorization Complete'
                  : 'Categorize emails'
              }
            </button>
          )}
          <button
            onClick={() => onGroupSelect(null)}
            className="w-full text-sm transition-colors hover:opacity-80 text-[#4a8dd9] px-3 py-1.5 rounded-md border border-transparent hover:bg-[#f0f7ff]"
          >
            View all mails
          </button>
        </div>
      </div>

      {/* Group Panels — stacked vertically */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div className="flex flex-col gap-3">
          {groups.map(group => (
            <motion.div
              key={group.id}
              whileHover={{ y: -2, scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className={cn(
                "w-full rounded-xl border cursor-pointer transition-all duration-200",
                selectedGroupId === group.id
                  ? "shadow-lg ring-2 ring-[#4a8dd9]"
                  : "hover:shadow-md",
                isUpdating && "opacity-75"
              )}
              style={{
                borderColor: selectedGroupId === group.id ? "#4a8dd9" : "#b8d4f0",
                boxShadow: selectedGroupId === group.id
                  ? "0 10px 25px rgba(74, 141, 217, 0.15)"
                  : undefined
              }}
              onClick={() => onGroupSelect(selectedGroupId === group.id ? null : group.id)}
            >
              <div className="p-4 rounded-xl bg-white/90">
                <div className="flex items-start">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-sm mb-1 line-clamp-2 text-[#2c5aa0]">
                      {group.name}
                    </h3>
                    <p className={cn(
                      "text-xs text-[#5a7ba8]",
                      isUpdating && "animate-pulse"
                    )}>
                      {group.count} emails
                      {isUpdating && (
                        <span className="ml-1 text-xs text-[#4a8dd9]">(updating...)</span>
                      )}
                    </p>
                  </div>
                  {/* Categorization spinner */}
                  {isUpdating && (
                    <div className="ml-2">
                      <div className="w-4 h-4 border-2 border-[#4a8dd9] border-t-transparent rounded-full animate-spin"></div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          ))}

          {groups.length === 0 && (
            <div className="flex items-center justify-center text-center py-12">
              <div>
                <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 bg-[#e1f0ff]">
                  <div className="w-6 h-6 rounded-full bg-[rgba(74,141,217,0.2)]" />
                </div>
                <h3 className="text-base font-medium mb-1 text-[#2c5aa0]">No groups found</h3>
                <p className="text-sm text-[#5a7ba8]">
                  Try adjusting your search or filter criteria
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Export for use with real data
export const createEmailGroups = (groups: EmailGroup[]) => {
  return <EmailGroups 
    groups={groups}
    selectedGroupId={null}
    onGroupSelect={() => {}}
    totalGroups={groups.length}
    totalEmails={groups.reduce((sum, group) => sum + group.count, 0)}
    onCategorizeEmails={undefined}
    isCategorizing={false}
    categorizationComplete={false}
    pendingResults={null}
  />;
};
