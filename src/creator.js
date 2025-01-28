// src/creator.js

const scopackager = require('simple-scorm-packager');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

const templateDir = path.join(__dirname, 'template');

const cleanAndTrim = text => {
  const textClean = text.replace(/[^a-zA-Z\d\s]/g, '');
  return textClean.replace(/\s/g, '');
};

const creator = async (outputDir, h5pContentDir, tempDir, masteryScore = 100) => {
  try {
    await fs.remove(tempDir);
    await fs.copy(templateDir, tempDir, {
      overwrite: true
    });
    await fs.copy(h5pContentDir, path.join(tempDir, 'workspace'), {
      overwrite: true
    });

    const h5p = await fs.readJSON(path.join(h5pContentDir, 'h5p.json'));

    const options = {
      version: '1.2',
      organization: h5p.authors && h5p.authors[0] ? h5p.authors[0].name : 'H5P Author',
      title: h5p.title || 'H5P Content',
      language: 'en-EN',
      identifier: '00',
      masteryScore: masteryScore,
      startingPage: 'index.html',
      source: tempDir,
      package: {
        version: '1.0.0',
        zip: true,
        outputFolder: outputDir,
        date: new Date().toISOString().slice(0, 10)
      }
    };

    const filename = await new Promise((resolve, reject) => {
      scopackager(options, async () => {
        await fs.remove(tempDir);
        const fileName = `${cleanAndTrim(options.title)}_v${options.package.version}_${options.package.date}.zip`;
        resolve(fileName);
      }).catch(err => {
        reject(err);
      });
    });

    return filename;
  } catch (error) {
    console.error(chalk.red('Error in creator:', error));
    throw new Error(`Error when packaging SCORM: ${error.message}`);
  }
};

exports.default = creator;
