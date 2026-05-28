import { createConsola } from 'consola'

export const log = createConsola({
  level: process.env.VERBOSE === '1' ? 4 : 3,
})
