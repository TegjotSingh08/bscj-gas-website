import type { MetadataRoute } from "next";
import { business } from "@/lib/business";

const routes = [
  { path: "/", priority: 1, changeFrequency: "weekly" as const },
  {
    path: "/gas-safety-certificate-wolverhampton",
    priority: 0.9,
    changeFrequency: "weekly" as const,
  },
  { path: "/book", priority: 0.9, changeFrequency: "weekly" as const },
  { path: "/about", priority: 0.6, changeFrequency: "monthly" as const },
  { path: "/contact", priority: 0.6, changeFrequency: "monthly" as const },
  { path: "/privacy", priority: 0.2, changeFrequency: "yearly" as const },
  { path: "/terms", priority: 0.2, changeFrequency: "yearly" as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return routes.map((route) => ({
    url: `${business.url}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
