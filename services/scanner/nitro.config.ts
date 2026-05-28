import { defineConfig } from 'nitro'

export default defineConfig({
  serverDir: '.',
  traceDeps: ['@tensorflow/tfjs-node*'],
})
