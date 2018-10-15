/**
 * Copyright 2018 Google Inc., PhantomJS Authors All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import fs from 'fs';
import express from 'express';
import bodyParser from 'body-parser';
import {createTask} from './tasks.mjs';
import Firestore from '@google-cloud/firestore';
import * as lighthouse from './lighthouse-data.mjs';
import fileNamer from 'lighthouse/lighthouse-core/lib/file-namer.js';

const PORT = process.env.PORT || 8080;
const LHR = JSON.parse(fs.readFileSync('./lhr.json', 'utf8'));

const app = express();

function requireUrlQueryParam(req, resp, next) {
  const url = req.query.url;
  if (!url) {
    return resp.status(400).send('No url provided.');
  }
  next();
}

app.use(function forceSSL(req, res, next) {
  const fromCron = req.get('X-Appengine-Cron');
  const fromTaskQueue = req.get('X-AppEngine-QueueName');
  if (!(fromCron || fromTaskQueue) && req.hostname !== 'localhost' &&
      req.get('X-Forwarded-Proto') === 'http') {
    return res.redirect(`https://${req.hostname}${req.url}`);
  }
  next();
});

app.use(bodyParser.raw());
app.use(bodyParser.json());
// app.use(bodyParser.text());
app.use(express.static('public'));
app.use('/node_modules', express.static('node_modules'));

app.get('/lh/seed_urls', async (req, resp) => {
  let urls = await lighthouse.getAllSavedUrls();
  if (urls.length) {
    return resp.status(401).send('URLs have already been seeded.');
  }

  // Schedule async task to fetch a new LH report for each URL in the seed.
  urls = JSON.parse(fs.readFileSync('./url_seed.json', 'utf8'));
  for (const url of urls) {
    createTask(url).catch(err => console.error(err));
  }

  resp.status(201).send('Update tasks scheduled');
});

app.get('/cron/update_lighthouse_scores', async (req, resp) => {
  if (!req.get('X-Appengine-Cron')) {
    return resp.status(403).send(
        'Sorry, handler can only be run as a GAE cron job.');
  }

  // Schedule async tasks to fetch a new LH report for each URL.
  const urls = await lighthouse.getAllSavedUrls();
  for (const url of urls) {
    createTask(url).catch(err => console.error(err));
  }

  resp.status(201).send('Update tasks scheduled');
});

// Enable cors on rest of handlers.
app.use(function enableCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/lh/categories', (req, resp) => {
  const result = Object.values(LHR.categories).map(cat => {
    return {
      title: cat.title,
      id: cat.id,
      manualDescription: cat.manualDescription
    };
  });
  resp.send(result);
});

app.get('/lh/audits', (req, resp) => {
  const result = Object.values(LHR.audits).map(audit => {
    return {
      title: audit.title,
      id: audit.id,
      description: audit.description,
    };
  });
  resp.send(result);
});

app.get('/lh/urls', async (req, resp) => {
  resp.status(200).json(await lighthouse.getAllSavedUrls());
});

app.use('/lh/html', requireUrlQueryParam);
app.get('/lh/html', async (req, resp, next) => {
  const url = req.query.url;
  const latestRun = (await lighthouse.getReports(url, {
    useCache: false,
    maxResults: 1,
  }))[0];
  if (!latestRun) {
    return resp.status(404).send(`No report found for ${url}`);
  }

  if ('download' in req.query) {
    const filename = `${fileNamer.getFilenamePrefix(latestRun.lhr)}.html`;
    resp.set('Content-Disposition', `attachment; filename=${filename}`);
  }

  // Send down LHR html report as response.
  resp.status(200).send(lighthouse.generateReport(latestRun.lhr, 'html'));
});

app.use('/lh/reports', requireUrlQueryParam);
app.get('/lh/reports', async (req, resp, next) => {
  const reports = await lighthouse.getReports(req.query.url);
  resp.status(200).json(reports);
});

app.use('/lh/medians', requireUrlQueryParam);
app.get('/lh/medians', async (req, resp, next) => {
  const url = req.query.url;
  const medians = url === 'all' ? await lighthouse.getMedianScoresOfAllUrls() :
      await lighthouse.getMedianScores(url);
  resp.status(200).json(medians);
});

app.post('/lh/newaudit', async (req, resp, next) => {
  let url = req.body.url || req.query.url;
  if (!url) {
    try {
      url = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
      // noop
    }
  }

  // Still no URL found, bomb out.
  if (!url) {
    return resp.status(400).send('No url provided.');
  }

  // Replace results when user is running new audit. Cron adds new entry.
  const replace = !req.get('X-AppEngine-QueueName');
  resp.status(201).json(await lighthouse.runLighthouse(url, replace));
});

app.use(function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  console.error('errorHandler', err);
  res.status(500).send({errors: `${err}`});
});

app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`); /* eslint-disable-line */
  console.log('Press Ctrl+C to quit.'); /* eslint-disable-line */
});

