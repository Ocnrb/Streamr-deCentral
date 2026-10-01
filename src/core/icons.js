// icons.js - The Lucide icons the pages use (only these are bundled): <i data-lucide="name"> becomes an inline SVG
import { createIcons, ChevronLeft, ChevronRight, CircleHelp, ExternalLink, Globe, Info, Network, Pause, Play, Search, Share2, SlidersHorizontal, Unlock, Users, X } from 'lucide';

const ICONS = { ChevronLeft, ChevronRight, CircleHelp, ExternalLink, Globe, Info, Network, Pause, Play, Search, Share2, SlidersHorizontal, Unlock, Users, X };

/** Replaces the <i data-lucide> placeholders in the page (or in options.root) with their icons */
export function renderIcons(options = {}) {
    createIcons({ icons: ICONS, ...options });
}
