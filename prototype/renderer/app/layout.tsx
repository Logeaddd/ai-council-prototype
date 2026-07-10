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
  colorScheme: "light dark",
  themeColor: "#f3eee2",
}

const themeScript = `
  try {
    const theme = localStorage.getItem("ai-council:theme");
    document.documentElement.classList.toggle("dark", theme === "dark");
  } catch {}
`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" className="bg-background" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="bg-background font-sans antialiased">{children}</body>
    </html>
  )
}
