/** News glyph adapted from the user-provided Desktop/news.svg asset. */
export function NewsIcon({ className }: { readonly className?: string | undefined }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1024 1024"
      width="1em"
      height="1em"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M384 810.666667h311.466667c-8.533333-12.8-12.8-25.6-12.8-42.666667V256H256v512c0 25.6 17.066667 42.666667 42.666667 42.666667h85.333333z m-170.666667-42.666667V213.333333h512v128h128v426.666667c0 46.933333-38.4 85.333333-85.333333 85.333333H298.666667c-46.933333 0-85.333333-38.4-85.333334-85.333333z m512-384v384c0 25.6 17.066667 42.666667 42.666667 42.666667s42.666667-17.066667 42.666667-42.666667V384h-85.333334zM341.333333 384h256v42.666667H341.333333V384z m0 128h256v42.666667H341.333333v-42.666667z m0 128h170.666667v42.666667H341.333333v-42.666667z"
      />
    </svg>
  )
}
