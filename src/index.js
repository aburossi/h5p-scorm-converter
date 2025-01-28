// src/index.js

const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs-extra');
const decompress = require('decompress');
const chalk = require('chalk');
const creator = require('./creator').default;
const filesize = require('filesize');
const { createObjectCsvWriter } = require('csv-writer');
const death = require('death');
const _ = require('lodash');

// Load environment variables
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const USE_STATISTICS = process.env.USE_STATISTICS === 'true';
const STATISTICS_FILE = path.resolve(process.env.STATISTICS_FILE || '/tmp/logs/statistics.csv');

// Vercel-compatible paths
const workingDir = path.join('/tmp', 'working_directory');
const uploadTmpDir = path.join(workingDir, 'downloads_tmp');
const h5pContentBaseDir = path.join(workingDir, 'workspace');
const tempBaseDir = path.join(workingDir, 'temp');
const outputDir = path.join(workingDir, 'output');

// Middleware
app.use(fileUpload());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../static')));

// Ensure working directories exist
const createWorkingDirectories = async () => {
  await fs.ensureDir(workingDir);
  await fs.ensureDir(uploadTmpDir);
  await fs.ensureDir(h5pContentBaseDir);
  await fs.ensureDir(tempBaseDir);
  await fs.ensureDir(outputDir);
};

createWorkingDirectories().catch(err => {
  console.error(chalk.red('Error creating working directories:', err));
  process.exit(1);
});

// Shutdown handler
death((sig, err) => {
  fs.removeSync(workingDir);
  process.exit();
});

// Compile index.html with placeholders
let compiledIndexHtml = '';
try {
  const imprint = fs.readFileSync(path.join(__dirname, '../static/imprint.html'), 'utf-8');
  const privacy = fs.readFileSync(path.join(__dirname, '../static/privacy.html'), 'utf-8');
  const license = fs.readFileSync(path.join(__dirname, '../static/license.html'), 'utf-8');
  const template = fs.readFileSync(path.join(__dirname, 'static/index.html'), 'utf-8');
  compiledIndexHtml = _.template(template)({ imprint, privacy, license });
} catch (err) {
  console.error(chalk.red('Error compiling index.html:', err));
  compiledIndexHtml = '<h1>Error loading application</h1>';
}

// Routes
app.get('/', (req, res) => {
  res.send(compiledIndexHtml);
});

app.get('/static/*', (req, res) => {
  res.sendFile(path.join(__dirname, '../static', req.path.replace('/static/', '')));
});

app.post('/convert', async (req, res) => {
  try {
    if (!req.files?.h5p_file) {
      return res.status(400).send('You must upload a H5P file.');
    }

    const uploadedFile = req.files.h5p_file;
    const masteryScore = req.body.h5p_mastery_score || 100;

    const uploadedFilePath = path.join(uploadTmpDir, uploadedFile.name);
    const tempDir = path.join(tempBaseDir, uploadedFile.name);

    // Move uploaded file
    await uploadedFile.mv(uploadedFilePath);

    // Uncompress H5P file
    const workspaceName = path.join(h5pContentBaseDir, uploadedFile.name);
    await decompress(uploadedFilePath, workspaceName);
    await fs.remove(uploadedFilePath);

    // Package SCORM
    let filename = '';
    try {
      filename = await creator(outputDir, workspaceName, tempDir, masteryScore);
    } catch (error) {
      console.error(chalk.red('SCORM packaging error:', error));
      return res.status(500).send('Error creating SCORM package');
    } finally {
      await fs.remove(workspaceName);
    }

    // Send SCORM package
    const scormFilePath = path.join(outputDir, filename);
    res.download(scormFilePath, async (err) => {
      await fs.remove(scormFilePath);
      if (err) console.error(chalk.red('Download error:', err));
    });

    // Log conversion
    console.log(`${new Date().toLocaleString()} - Converted: ${uploadedFile.name} (${filesize(uploadedFile.size})`);

    // Handle statistics
    if (USE_STATISTICS) {
      let contentTypeMachineName = 'unknown';
      let contentTypeVersion = 'unknown';

      try {
        const h5pMetadata = await fs.readJSON(path.join(workspaceName, 'h5p.json'));
        const mainLibrary = h5pMetadata.preloadedDependencies.find(
          dep => dep.machineName === h5pMetadata.mainLibrary
        );
        if (mainLibrary) {
          contentTypeMachineName = mainLibrary.machineName;
          contentTypeVersion = `${mainLibrary.majorVersion}.${mainLibrary.minorVersion}`;
        }
      } catch (error) {
        console.error(chalk.red('Metadata read error:', error));
      }

      const csvWriter = createObjectCsvWriter({
        append: true,
        path: STATISTICS_FILE,
        header: [
          { id: 'time', title: 'Time' },
          { id: 'ctMachineName', title: 'Content Type' },
          { id: 'ctVersion', title: 'Version' },
          { id: 'filesize', title: 'Size' }
        ]
      });

      await csvWriter.writeRecords([{
        time: new Date().toUTCString(),
        ctMachineName: contentTypeMachineName,
        ctVersion: contentTypeVersion,
        filesize: uploadedFile.size
      }]);
    }

  } catch (err) {
    console.error(chalk.red('Conversion error:', err));
    res.status(500).send('Internal Server Error');
  }
});

// Vercel requires module.exports for serverless functions
module.exports = app;

// Start local server if not in Vercel environment
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(chalk.green(`Server running on port ${PORT}`));
  });
}