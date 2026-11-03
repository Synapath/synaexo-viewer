import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packages = ['react', 'react-dom', 'scheduler', '@zip.js/zip.js', 'lucide-react']
const notices = packages.map(name => {
  const directory = dirname(require.resolve(`${name}/package.json`))
  return `${name}\n${readFileSync(join(directory, 'LICENSE'), 'utf8').trim()}`
})
writeFileSync(new URL('../public/third-party-licenses.txt', import.meta.url), notices.join('\n\n---\n\n') + '\n')
