import type { Metadata, Viewport } from "next";
import { Inter, Lexend } from "next/font/google";
import "./globals.css";
import "katex/dist/katex.min.css";
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
        {/* Light is the default for everyone; the OS preference is deliberately
            not followed. The sidebar toggle still switches to dark and persists
            that choice per browser. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          <ConfirmDialogProvider>
            {children}
          </ConfirmDialogProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
