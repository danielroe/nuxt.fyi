import { defineConfig } from 'nitro'

export default defineConfig({
  serverDir: '.',
  builder: 'rolldown',
  traceDeps: [
    '@tensorflow/tfjs*',
    '@tensorflow/tfjs-node*',
    '@tensorflow/tfjs-core*',
    '@tensorflow/tfjs-converter*',
    '@tensorflow/tfjs-layers*',
    '@tensorflow/tfjs-backend-cpu*',
    '@tensorflow/tfjs-backend-webgl*',
    '@tensorflow/tfjs-data*',
    'nsfwjs*',
  ],
})
