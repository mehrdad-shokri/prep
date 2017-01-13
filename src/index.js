#!/usr/bin/env node

import program from 'commander'
import path from 'path'
import fs from 'fs'
import http from 'http'
import https from 'https'
import express from 'express'
import serveStatic from 'serve-static'
import fallback from 'express-history-api-fallback'
import mkdirp from 'mkdirp'
import { exec } from 'child-process-promise'
import Bluebird from 'bluebird'
import sitemap from 'sitemap'
import Nightmare from 'nightmare'

const { version } = require('../package.json')

let buildDir, targetDir, tmpDir

async function crawlAndWrite (configuration) {

  // prepare configuration
  const dimensions = Object.assign({}, {width: 1440, height: 900}, configuration.dimensions)
  delete configuration.dimensions

  configuration = Object.assign({}, {
    routes: ['/'],
    timeout: 1000,
    dimensions,
    https: false,
    hostname: 'http://localhost',
    useragent: 'Prep',
    concurrency: 4,
  }, configuration)

  // render sitemap
  const sm = sitemap.createSitemap({
    hostname: configuration.hostname,
    urls: configuration.routes.map((route) => ({url: route}))
  })
  mkdirp.sync(targetDir)
  fs.writeFileSync(`${targetDir}/sitemap.xml`, sm.toString());

  // start temporary local webserver
  const app = express()
    .use(serveStatic(buildDir))
    .use(fallback('index.html', { root: buildDir }))
  let server
  if (configuration.https) {
    const credentials = {
      key: fs.readFileSync(`${__dirname}/../ssl/key.pem`),
      cert: fs.readFileSync(`${__dirname}/../ssl/cert.pem`),
    }
    server = https.createServer(credentials, app)
  } else {
    server = http.createServer(app)
  }

  server.listen(program.port)

  // render routes
  const promises = configuration.routes.map((route) => async () => {
    // remove leading slash from route
    route = route.replace(/^\//, '')

    const nightmare = Nightmare({
      show: false,
      switches: {
        'ignore-certificate-errors': true,
      },
    })

    const content = await nightmare
      .useragent()
      .viewport(configuration.dimensions.width, configuration.dimensions.height)
      .goto(`http${configuration.https ? 's' : ''}://localhost:${program.port}/${route}`)
      .wait(configuration.timeout)
      .evaluate(() => document.documentElement.outerHTML)
      .end()

    const filePath = path.join(tmpDir, route)
    mkdirp.sync(filePath)
    fs.writeFileSync(path.join(filePath, 'index.html'), content)

    const logFileName = `${route}/index.html`.replace(/^\//, '')
    console.log(`prep: Rendered ${logFileName}`)
  })

  // clean up files
  await Bluebird.map(promises, fn => fn(), {concurrency: configuration.concurrency})
  server.close()
  await exec(`cp -rf "${tmpDir}"/* "${targetDir}"/`)
  await exec(`rm -rf "${tmpDir}"`)
  process.exit(0)
}

async function run () {
  try {
    program
      .version(version)
      .description('Server-side rendering tool for your web app.\n  Prerenders your app into static HTML files and supports routing.')
      .arguments('<build-dir> [target-dir]')
      .option('-c, --config [path]', 'Config file (Default: prep.js)', 'prep.js')
      .option('-p, --port [port]', 'Temporary webserver port (Default: 45678)', 45678)
      .action((bdir, tdir) => {
        if (!bdir) {
          console.log('No target directory provided.')
          process.exit(1)
        }

        buildDir = path.resolve(bdir)
        targetDir = tdir ? path.resolve(tdir) : buildDir
        tmpDir = path.resolve('.prep-tmp')
      })

    program.parse(process.argv)

    if (!buildDir) {
      program.help()
    }

    const config = require(path.resolve(program.config)).default

    if (typeof config === 'function') {
      const fnConfig = config()
      if (Promise.resolve(fnConfig) === fnConfig) {
        await crawlAndWrite(await fnConfig)
      } else {
        await crawlAndWrite(fnConfig)
      }
    } else {
      await crawlAndWrite(config)
    }
  } catch (e) {
    console.log(e)
    process.exit(1)
  }
}

run()
