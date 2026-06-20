import type { Metadata, Viewport } from "next";
import { Inter, Lexend } from "next/font/google";
import "./globals.css";
import "katex/dist/katex.min.css";
import Chatbot from "@/components/Chatbot";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { ThemeProvider } from "@/components/theme-provider";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const lexend = Lexend({
  subsets: ["latin"],
  variable: "--font-lexend",
  weight: ["500", "600", "700"],
});

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
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${lexend.variable}`}>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <ConfirmDialogProvider>
            {children}
            <Chatbot />
          </ConfirmDialogProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
