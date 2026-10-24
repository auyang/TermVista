import type { APIRoute } from 'astro';

export const prerender = true;

const origin = 'https://auyang.github.io/TermVista';
const pages = ['', 'zh-cn/', 'ja/', 'zh-tw/'];

export const GET: APIRoute = () => {
  const urls = pages.map((path) => `  <url><loc>${origin}/${path}</loc></url>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
