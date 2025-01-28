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
const STATISTICS_FILE = path.resolve(process.env.STATISTICS_FILE || 'logs/statistics.csv');

const workingDir = path.join(__dirname, '..', 'working_directory');
const uploadTmpDir = path.join(workingDir, 'downloads_tmp');
const h5pContentBaseDir = path.join(workingDir, 'workspace');
const tempBaseDir = path.join(workingDir, 'temp');
const outputDir = path.join(workingDir, 'output');

// Middleware
app.use(fileUpload());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'static')));

// Ensure working directories exist
const createWorkingDirectories = async () => {
  await fs.ensureDir(workingDir);
  await fs.ensureDir(uploadTmpDir);
  await fs.ensureDir(h5pContentBaseDir);
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
const compileIndexHtml = async () => {
  try {
    const templatePath = path.join(__dirname, 'static', 'index.html');
    const imprint = await fs.readFile(path.join(__dirname, '..', 'static', 'imprint.html'), 'utf-8');
    const privacy = await fs.readFile(path.join(__dirname, '..', 'static', 'privacy.html'), 'utf-8');
    const license = await fs.readFile(path.join(__dirname, '..', 'static', 'license.html'), 'utf-8');

    const templateContent = await fs.readFile(templatePath, 'utf-8');
    const compiled = _.template(templateContent)({ imprint, privacy, license });
    return compiled;
  } catch (err) {
    console.error(chalk.red('Error compiling index.html:', err));
    throw err;
  }
};

let compiledIndexHtml = '';
compileIndexHtml()
  .then(compiled => {
    compiledIndexHtml = compiled;
  })
  .catch(err => {
    console.error(chalk.red('Failed to compile index.html'));
  });

// Routes
app.get('/', (req, res) => {
  res.send(compiledIndexHtml);
});

app.post('/convert', async (req, res) => {
  try {
    if (!req.files || !req.files.h5p_file) {
      return res.status(400).send('You must upload a H5P file.');
    }

    const uploadedFile = req.files.h5p_file;
    const masteryScore = req.body.h5p_mastery_score;

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
      console.error(chalk.red('Error during SCORM packaging:', error));
      return res.status(500).send('Error during SCORM packaging. Please try again.');
    } finally {
      await fs.remove(workspaceName);
    }

    if (!filename) {
      return res.status(500).send('Failed to create SCORM package.');
    }

    // Send SCORM package to user
    const scormFilePath = path.join(outputDir, filename);
    res.download(scormFilePath, async err => {
      if (err) {
        console.error(chalk.red('Error sending file:', err));
      }
      await fs.remove(scormFilePath);
    });

    // Log successful conversion
    console.log(
      `${new Date().toLocaleString()} - Successfully converted file (${uploadedFile.name}, ${filesize(uploadedFile.size)}).`
    );

    // Log statistics if enabled
    if (USE_STATISTICS) {
      const scormMetadataPath = path.join(workspaceName, 'h5p.json');
      let contentTypeMachineName = 'unknown';
      let contentTypeVersion = 'unknown';

      try {
        const h5pMetadata = await fs.readJSON(scormMetadataPath);
        const mainLibrary = h5pMetadata.preloadedDependencies.find(
          dep => dep.machineName === h5pMetadata.mainLibrary
        );
        if (mainLibrary) {
          contentTypeMachineName = mainLibrary.machineName;
          contentTypeVersion = `${mainLibrary.majorVersion}.${mainLibrary.minorVersion}`;
        }
      } catch (error) {
        console.error(chalk.red('Could not read H5P metadata:', error));
      }

      const header = [
        { id: 'time', title: 'Time' },
        { id: 'ctMachineName', title: 'Content Type' },
        { id: 'ctVersion', title: 'Content Type Version' },
        { id: 'filesize', title: 'Size (in bytes)' }
      ];

      const csvWriter = createObjectCsvWriter({
        append: true,
        path: STATISTICS_FILE,
        header
      });

      if (!(await fs.pathExists(STATISTICS_FILE))) {
        const csvW = require('csv-writer').createObjectCsvStringifier({ header });
        await fs.writeFile(STATISTICS_FILE, csvW.getHeaderString());
      }

      await csvWriter.writeRecords([
        {
          time: new Date().toUTCString(),
          ctMachineName: contentTypeMachineName,
          ctVersion: contentTypeVersion,
          filesize: uploadedFile.size
        }
      ]);
    }
  } catch (err) {
    console.error(chalk.red('Error processing conversion:', err));
    res.status(500).send('Internal Server Error');
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(chalk.green(`Server is running on port ${PORT}`));
});
