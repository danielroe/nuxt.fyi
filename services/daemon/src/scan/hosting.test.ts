import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectHosting } from './hosting.ts'

test('no distinctive headers yields nulls', () => {
  assert.deepEqual(
    detectHosting(new Headers({ 'server': 'nginx', 'content-type': 'text/html' })),
    { platform: null, cdn: null },
  )
})

test('vercel via x-vercel-id', () => {
  assert.deepEqual(detectHosting(new Headers({ 'x-vercel-id': 'fra1::abc-123' })), { platform: 'vercel', cdn: null })
})

test('vercel behind cloudflare reports both', () => {
  assert.deepEqual(
    detectHosting(new Headers({ 'cf-ray': '8abc-FRA', 'x-vercel-id': 'fra1::abc' })),
    { platform: 'vercel', cdn: 'cloudflare' },
  )
})

test('cloudflare-only site has null platform', () => {
  assert.deepEqual(
    detectHosting(new Headers({ 'cf-ray': '8abc-FRA', 'server': 'cloudflare' })),
    { platform: null, cdn: 'cloudflare' },
  )
})

test('netlify via x-nf-request-id', () => {
  assert.deepEqual(detectHosting(new Headers({ 'x-nf-request-id': '01ABC' })), { platform: 'netlify', cdn: null })
})

test('fly via fly-request-id', () => {
  assert.deepEqual(detectHosting(new Headers({ 'fly-request-id': '01ABC-lhr' })), { platform: 'fly', cdn: null })
})

test('cloudfront via x-amz-cf-id', () => {
  assert.deepEqual(detectHosting(new Headers({ 'x-amz-cf-id': 'abc==' })), { platform: null, cdn: 'aws-cloudfront' })
})

test('github pages behind fastly reports both', () => {
  assert.deepEqual(
    detectHosting(new Headers({ 'server': 'GitHub.com', 'x-served-by': 'cache-lhr7365-LHR' })),
    { platform: 'github-pages', cdn: 'fastly' },
  )
})

test('heroku via vegur', () => {
  assert.deepEqual(detectHosting(new Headers({ via: '1.1 vegur' })), { platform: 'heroku', cdn: null })
})
