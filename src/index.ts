import * as core from '@actions/core';
import * as github from '@actions/github';
import {execFile} from 'child_process';
import * as micromatch from 'micromatch';
import {promisify} from 'util';

const execFileP = promisify(execFile);
const octokit = github.getOctokit(core.getInput('token'));
const context = github.context;
const {repo} = context;
const event_type = context.eventName;

async function doGrepBasedBinaryCheck(
  filename: string,
  consideredBinaryFiles: string[],
  inclusionPatterns: string[],
  inclusionPatternMatchingFiles: string[]
) {
  try {
    const grepOutput = await execFileP('grep', ['-IL', '.', filename]);
    if (grepOutput.stdout && grepOutput.stdout.length > 0) {
      core.info(`File is considered binary but not LFS tracked: ${filename}`);
      consideredBinaryFiles.push(filename);
    }
  } catch (error) {
    //Exit code 1 was returned. So it's not a binary file.
    core.debug(`An error occurred: ${error}`);
    if (inclusionPatterns.length > 0) {
      // Checking inclusion pattern
      if (micromatch.isMatch(filename, inclusionPatterns)) {
        inclusionPatternMatchingFiles.push(filename);
      }
    }
  }
}

async function run() {
  const fsl = getFileSizeLimitBytes();

  core.info(`Filesizelimit is set to ${fsl} bytes.`);
  core.info(
    `Name of Repository is ${repo.repo} and the owner is ${repo.owner}`
  );
  core.info(`Triggered event is ${event_type}`);

  const labelName = core.getInput('labelName');
  const labelColor = core.getInput('labelColor');

  await getOrCreateLfsWarningLabel(labelName, labelColor);

  if (event_type === 'pull_request') {
    const pullRequestNumber = context.payload.pull_request?.number;

    if (pullRequestNumber === undefined) {
      throw new Error('Could not get PR number');
    }

    core.info(`The PR number is: ${pullRequestNumber}`);

    const prFilesWithBlobSize = await getPrFilesWithBlobSize(pullRequestNumber);

    core.debug(`prFilesWithBlobSize: ${JSON.stringify(prFilesWithBlobSize)}`);

    const inclusionPatterns = core.getMultilineInput('inclusionPatterns');

    const largeFiles: string[] = [];
    const accidentallyCheckedInLsfFiles: string[] = [];
    const consideredBinaryFiles: string[] = [];
    const inclusionPatternMatchingFiles: string[] = [];
    for (const file of prFilesWithBlobSize) {
      const {fileBlobSize: fileBlobSize, filename} = file;
      if (fileBlobSize !== null && fileBlobSize > Number(fsl)) {
        largeFiles.push(filename);
      } else {
        // look for files below threshold that should be stored in LFS but are not
        const shouldBeStoredInLFS = (
          await execFileP('git', ['check-attr', 'filter', filename])
        ).stdout.includes('filter: lfs');

        if (shouldBeStoredInLFS) {
          const isStoredInLFS = Boolean(
            file.patch?.includes('version https://git-lfs.github.com/spec/v1')
          );
          if (!isStoredInLFS) {
            accidentallyCheckedInLsfFiles.push(filename);
          }
        } else {
          await doGrepBasedBinaryCheck(
            filename,
            consideredBinaryFiles,
            inclusionPatterns,
            inclusionPatternMatchingFiles
          );
        }
      }
    }

    let lsfFiles = largeFiles.concat(accidentallyCheckedInLsfFiles);
    lsfFiles = lsfFiles.concat(consideredBinaryFiles);
    lsfFiles = lsfFiles.concat(inclusionPatternMatchingFiles);

    const issueBaseProps = {
      ...repo,
      issue_number: pullRequestNumber,
    };

    if (lsfFiles.length > 0) {
      core.info('Detected file(s) that should be in LFS: ');
      core.info(lsfFiles.join('\n'));

      const body = getCommentBody(
        largeFiles,
        accidentallyCheckedInLsfFiles,
        consideredBinaryFiles,
        inclusionPatternMatchingFiles,
        fsl
      );

      await Promise.all([
        octokit.rest.issues.addLabels({
          ...issueBaseProps,
          labels: [labelName],
        }),
        octokit.rest.issues.createComment({
          ...issueBaseProps,
          body,
        }),
      ]);

      core.setOutput('lfsFiles', lsfFiles);
      core.setFailed(
        'Large file(s) detected! Setting PR status to failed. Consider using git-lfs to track the LFS file(s)'
      );
    } else {
      core.info('No large file(s) detected...');

      const {data: labels} = await octokit.rest.issues.listLabelsOnIssue({
        ...issueBaseProps,
      });
      if (labels.map(l => l.name).includes(labelName)) {
        await octokit.rest.issues.removeLabel({
          ...issueBaseProps,
          name: labelName,
        });
        core.info(`label ${labelName} removed`);
      }
    }
  } else {
    core.info('No Pull Request detected. Skipping LFS warning check');
  }
}

run().catch(error => {
  core.setFailed(error.message);
});

function getFileSizeLimitBytes() {
  const fsl = core.getInput('filesizelimit');

  const lastTwoChars = fsl.slice(-2).toLowerCase();

  if (lastTwoChars === 'kb') {
    return Number(fsl.slice(0, -2)) * 1024;
  } else if (lastTwoChars === 'mb') {
    return Number(fsl.slice(0, -2)) * 1024 * 1024;
  } else if (lastTwoChars === 'gb') {
    return Number(fsl.slice(0, -2)) * 1024 * 1024 * 1024;
  } else if (lastTwoChars[1] === 'b') {
    return fsl.slice(0, -1);
  } else {
    return fsl;
  }
}

async function getOrCreateLfsWarningLabel(
  labelName: string,
  labelColor: string
) {
  try {
    await octokit.rest.issues.getLabel({
      ...repo,
      name: labelName,
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Not Found') {
        await octokit.rest.issues.createLabel({
          ...repo,
          name: labelName,
          color: labelColor,
          description:
            'Warning Label for use when LFS is detected in the commits of a Pull Request',
        });
        core.info('No lfs warning label detected. Creating new label ...');
        core.info('LFS warning label created');
      } else {
        core.error(`getLabel error: ${error.message}`);
      }
    }
  }
}

async function getPrFilesWithBlobSize(pullRequestNumber: number) {
  const {data} = await octokit.rest.pulls.listFiles({
    ...repo,
    pull_number: pullRequestNumber,
  });

  const exclusionPatterns = core.getMultilineInput('exclusionPatterns');

  const files =
    exclusionPatterns.length > 0
      ? data.filter(({filename}) => {
          const isExcluded = micromatch.isMatch(filename, exclusionPatterns);
          if (isExcluded) {
            core.info(`${filename} has been excluded from LFS warning`);
          }
          return !isExcluded;
        })
      : data;

  const prFilesWithBlobSize = await Promise.all(
    files.map(async file => {
      const {filename, sha, patch} = file;
      const {data: blob} = await octokit.rest.git.getBlob({
        ...repo,
        file_sha: sha,
      });

      return {
        filename,
        fileSha: sha,
        fileBlobSize: blob.size,
        patch,
      };
    })
  );
  return prFilesWithBlobSize;
}

function getCommentBody(
  largeFiles: string[],
  accidentallyCheckedInLsfFiles: string[],
  consideredBinaryFiles: string[],
  inclusionPatternMatchingFiles: string[],
  fsl: string | number
) {
  const largeFilesBody = `The following file(s) exceeds the file size limit: ${fsl} bytes, as set in the .yml configuration files:

        ${largeFiles.join(', ')}

        Consider using git-lfs to manage large files.
      `;

  const accidentallyCheckedInLsfFilesBody = `The following file(s) are tracked in LFS and were likely accidentally checked in:

        ${accidentallyCheckedInLsfFiles.join(', ')}
      `;

  const considererdBinaryFilesBody = `The following file(s) are of binary type and should be tracked in LFS:

        ${consideredBinaryFiles.join(', ')}
      `;

  const inclusionPatternMatchingFilesBody = `The following file(s) are matching an inclusion pattern and should be tracked in LFS:

        ${inclusionPatternMatchingFiles.join(', ')}
      `;
  const body = `## :warning: Possible file(s) that should be tracked in LFS detected :warning:
        ${largeFiles.length > 0 ? largeFilesBody : ''}
        
        ${
          accidentallyCheckedInLsfFiles.length > 0
            ? accidentallyCheckedInLsfFilesBody
            : ''
        }

        ${consideredBinaryFiles.length > 0 ? considererdBinaryFilesBody : ''}

        ${
          inclusionPatternMatchingFiles.length > 0
            ? inclusionPatternMatchingFilesBody
            : ''
        }`;
  return body;
}
