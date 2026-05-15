import { useEffect, useState } from 'react'

type Theme = 'dark' | 'light'

function resolveInitial(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const stored = localStorage.getItem('theme')
  if (stored === 'dark' || stored === 'light') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(resolveInitial)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    // Mirror onto <body> using the editorial design's convention
    // (data-theme="ink" = dark, absent = ivory) so stacsol.css's
    // body[data-theme="ink"] palette switch fires.
    if (theme === 'dark') document.body.setAttribute('data-theme', 'ink')
    else document.body.removeAttribute('data-theme')
    localStorage.setItem('theme', theme)
  }, [theme])

  const toggle = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))

  return { theme, toggle }
}
