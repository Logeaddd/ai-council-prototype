import type { Metadata, Viewport } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "AI Council · 智能议会",
  generator: "v0.app",
  icons: {
    icon: [
      { url: "/logo.png", type: "image/png" },
      { url: "/icon-light-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
}

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#1a1f26",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" className="bg-background">
      <body className="bg-background font-sans antialiased">{children}</body>
    </html>
  )
}
