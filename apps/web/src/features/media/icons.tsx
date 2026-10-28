// Icons media and calls need beyond the shared set (ui/icons.tsx is lead-owned).
// Same grid and stroke as the shared set so they sit side by side.
import type { SVGProps } from 'react';

const FILE = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6';
const PHONE = 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z';

const PATHS = {
  screen: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 21h8M12 17v4M9 10.5 12 7.5l3 3M12 7.5v6',
  screenStop: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 21h8M12 17v4M9.5 8l5 5M14.5 8l-5 5',
  fileText: `${FILE}M16 13H8M16 17H8M10 9H8`,
  fileSheet: `${FILE}M8 13h8M8 17h8M12 11v8`,
  fileSlides: `${FILE}M8 12h8v6H8z`,
  fileZip: `${FILE}M10 4h1M10 7h1M10 10h1M9 14h2v4H9z`,
  fileAudio: `${FILE}M10 18a2 2 0 1 1-2-2 2 2 0 0 1 2 2zM10 18v-6l5-1`,
  fileVideo: `${FILE}M10 11l5 3-5 3z`,
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  play: 'M7 4l13 8-13 8z',
  maximize: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  minimize: 'M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  phoneIncoming: `${PHONE}M16 2v6h6M22 2l-6 6`,
  phone: PHONE,
  imageOff: 'M2 2l20 20M10.4 5H19a2 2 0 0 1 2 2v8.6M21 19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5c0-.6.3-1.1.7-1.5M14.1 14.1 5 21',
  speaker: 'M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7',
  retry: 'M1 4v6h6M3.5 15a9 9 0 1 0 2.1-9.4L1 10',
} as const;

export type MediaIconName = keyof typeof PATHS;

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: MediaIconName;
  size?: number;
  label?: string;
}

export function MIcon({ name, size = 20, label, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
