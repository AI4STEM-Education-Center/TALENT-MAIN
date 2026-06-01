import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Chatbot from "@/components/Chatbot";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Adaptive Learning Platform",
  description: "AI-powered adaptive learning for science education",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ConfirmDialogProvider>
          {children}
          <Chatbot />
        </ConfirmDialogProvider>
      </body>
    </html>
  );
}
