import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Navigation } from '@/components/navigation';
import { Button } from '@/components/ui/button';
import Footer from '@/components/home/footer';
import { ArrowLeft } from 'lucide-react';
import React from 'react';

export default function TermsOfService() {
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-auto bg-white dark:bg-[#111111]">
      <Navigation />
      <div className="relative z-10 flex flex-grow flex-col">
        {/* Back Button */}
        <div className="absolute right-4 top-6 md:left-8 md:right-auto md:top-8">
          <a href="/">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-gray-600 hover:text-gray-900 dark:text-white dark:hover:text-white/80"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </a>
        </div>

        <div className="container mx-auto max-w-4xl px-4 py-16">
          <Card className="overflow-hidden rounded-xl border-none bg-gray-50/80 dark:bg-transparent">
            <CardHeader className="space-y-4 px-8 py-8">
              <div className="space-y-2 text-center">
                <CardTitle className="text-3xl font-bold tracking-tight text-gray-900 md:text-4xl dark:text-white">
                  Terms of Service
                </CardTitle>
              </div>
            </CardHeader>

            <div className="px-8 pb-12">
              <p className="text-center text-base text-gray-600 dark:text-white/70">
                Our Terms of Service are being finalised and will be published here soon.
              </p>
            </div>
          </Card>
        </div>

        <Footer />
      </div>
    </div>
  );
}
