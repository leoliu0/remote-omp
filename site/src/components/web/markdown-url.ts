// URL policy for the assistant markdown renderer. react-markdown's default
// transform drops every `data:` URL, so a reply that embeds a picture as
// `![x](data:image/png;base64,…)` showed nothing. Raster base64 images are
// allowed as an <img> source only; svg (can carry script when opened), other
// data URIs and every `data:` link keep the default (stripped) handling.
import { defaultUrlTransform } from "react-markdown";

const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** True for a base64 png/jpeg/gif/webp data URI. */
export function isRasterDataImage(url: string): boolean {
  return DATA_IMAGE.test(url);
}

export function markdownUrlTransform(url: string, key: string, node: Readonly<{ tagName: string }>): string {
  if (key === "src" && node.tagName === "img" && isRasterDataImage(url)) return url;
  return defaultUrlTransform(url);
}
