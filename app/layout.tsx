import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#090b0c",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "六合智研｜香港与新澳门开奖及规律研究";
  const description = "香港与新澳门双彩开奖数据、历史统计与可审计规律研究：逐条公开命中率、随机基线、区间、q值及滚动回测。";

  return {
    metadataBase: new URL(origin),
    title: { default: title, template: "%s｜六合智研" },
    description:
      "香港六合彩与新澳门六合彩当期开奖、历史记录、号码统计、规律发现与滚动回测。北京时间口径。",
    keywords: ["香港六合彩", "新澳门六合彩", "开奖记录", "历史统计", "规律研究", "滚动回测"],
    openGraph: {
      title,
      description,
      type: "website",
      locale: "zh_CN",
      images: [{ url: `${origin}/og-v3.png`, width: 1200, height: 630, alt: "六合智研香港与新澳门开奖及规律研究" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og-v3.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
