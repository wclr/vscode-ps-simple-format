import { exec } from 'child_process'
import fs from 'fs'
import path from 'path'
import pkgUp from 'pkg-up'
import vscode from 'vscode'
import which from 'which'

const { formatDefault, adjustIndentDefault } = require('purs-top-level-format')

type Range = {
  start: {
    line: number
    character: number
  }
  end: {
    line: number
    character: number
  }
}

const getDocRange = (document: vscode.TextDocument): vscode.Range => {
  const lastLineId = document.lineCount - 1
  return new vscode.Range(
    0,
    0,
    lastLineId,
    document.lineAt(lastLineId).text.length
  )
}

let output: vscode.OutputChannel

function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Purs format debug')
  console.log('Congratulations, your extension "vscode-purty" is now active!')
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      { scheme: 'file', language: 'purescript' },
      {
        provideDocumentFormattingEdits: (doc) =>
          topFormat(doc, getDocRange(doc)),
      }
    ),
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      { scheme: 'file', language: 'purescript' },
      {
        provideDocumentRangeFormattingEdits: (doc, range) =>
          purtyFormat(doc, normalizeSelectedTextRange(doc, range)),
      }
    )
  )
}

const topFormat = (
  document: vscode.TextDocument,
  range: vscode.Range
): Promise<vscode.TextEdit[]> => {
  output.appendLine('topFormat')
  return Promise.resolve(formatDefault(document.getText(range)))
    .then((stdout) => {
      return [vscode.TextEdit.replace(range, stdout)]
    })
    .catch((err) => {
      console.log(err)
      return []
    })
}

const rangeFromLines = (
  document: vscode.TextDocument,
  startLine: number,
  endLine: number
) =>
  new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, document.lineAt(endLine).text.length)
  )

const normalizeSelectedTextRange = (
  document: vscode.TextDocument,
  range: vscode.Range
) => rangeFromLines(document, range.start.line, range.end.line)

const getSymbolsCount = (text: string) => {
  return text.replace(/\s/g, '').length
}

const isWhiteSpace = (ch: string) => ch === ' '

// positive count - remove (shift) from right to left <--
const removeSymbolsFromLine = (str: string, count: number) => {
  if (count === 0) return str
  const chars = str.split('')
  const r =
    count > 0
      ? chars.reduceRight(
          (p, ch) => {
            return {
              res: p.count > 0 ? '' : ch + p.res,
              count: p.count - (isWhiteSpace(ch) ? 0 : 1),
            }
          },
          { res: '', count }
        )
      : chars.reduce(
          (p, ch) => {
            return {
              res: p.count > 0 ? p.res + ch : '',
              count: p.count - (isWhiteSpace(ch) ? 0 : 1),
            }
          },
          { res: '', count }
        )
  return r.res
}

const findLineSymCount = (
  text: string,
  startSymCount: number,
  endSymCount: number
): {
  start: { line: number; chars: number }
  end: { line: number; chars: number }
} => {
  const chars = text
    .split('\n')
    .map((s) => s.trim())
    .join('\n')
    .split('')
  const isNewLine = (ch: string) => ch === '\n'
  const getLine = (dir: 1 | -1, count: number) => {
    const method = dir === 1 ? 'reduce' : 'reduceRight'
    output.appendLine(['getLine', count, dir].join(' '))
    const r = chars[method](
      (p, ch) => {
        const isNew = isNewLine(ch)
        const char = isWhiteSpace(ch) || isNew ? 0 : 1

        return p.count > count
          ? p
          : p.count === count
          ? {
              count: p.count + 1,
              chars: isNew ? 0 : p.chars,
              line: p.line + (isNew ? dir : 0),
            }
          : {
              count: p.count + char,
              chars: isNew ? 0 : p.chars + char * dir,
              line: p.line + (isNew ? dir : 0),
            }
      },
      { count: 0, line: 0, chars: 0 }
    )
    return {
      chars: r.chars,
      line: r.line,
    }
  }

  return {
    start: getLine(1, startSymCount),
    end: getLine(-1, endSymCount),
  }
}

const removeCharsAndSplit = (text: string, charsToRemove: number) => {
  return removeSymbolsFromLine(text, charsToRemove).split('/n')
}

const purtyFormat = (
  document: vscode.TextDocument,
  range: vscode.Range
): Promise<vscode.TextEdit[]> => {
  //console.debug('formatting purescript')
  output.appendLine('Getting top range')
  const topRange = getTopLevelRange(document, range)
  // vscode.window.showInformationMessage(
  //   ['Range', topRange.start.line, topRange.end.line].join(':')
  // )
  output.appendLine(
    ['Top range (lines)', topRange.start.line, topRange.end.line].join(':')
  )

  // const selectedText = document.getText(range)
  // const wholeTopBlockText = document.getText(topRange)

  const textFromStart = document.getText(
    rangeFromLines(document, topRange.start.line, range.start.line - 1)
  )

  const textToEnd = document.getText(
    rangeFromLines(document, range.end.line + 1, topRange.end.line)
  )

  return purty(document, topRange)
    .then((formatted) => {
      const symLines = findLineSymCount(
        formatted,
        getSymbolsCount(textFromStart),
        getSymbolsCount(textToEnd)
      )
      output.appendLine('symLines:' + JSON.stringify(symLines))
      const formattedCutLines = formatted
        .split('\n')
        .slice(symLines.start.line, symLines.end.line)

      const topWithFormattedCut = [
        ...removeCharsAndSplit(textFromStart, symLines.start.chars),
        ...formattedCutLines,
        removeCharsAndSplit(textToEnd, symLines.end.chars),
      ].join('\n')

      output.appendLine('formattedCut:\n' + formattedCutLines.join('\n'))

      output.appendLine('whole:\n' + topWithFormattedCut)

      // output.appendLine('formatted:' + formatted)
      const whole = [
        document.getText(rangeFromLines(document, 0, topRange.start.line - 1)),
        // adjustIndentDefault(topWithFormattedCut),
        topWithFormattedCut,
        document.getText(
          rangeFromLines(
            document,
            topRange.end.line + 1,
            document.lineCount - 1
          )
        ),
      ].join('\n')
      return [
        vscode.TextEdit.replace(getDocRange(document), formatDefault(whole)),
      ]
      //return [vscode.TextEdit.replace(topRange, topWithFormattedCut)]
    })
    .catch((err) => {
      // We have already checked that the exe exists and is executable, any errors
      // at this point are most likely syntax errors that are better flagged by the
      // linter, so we just log to the console and finish.
      console.log(err)
      return [] // We must return an array of edits, in this case nothing.
    })
}

const geTextToFormat = (text: string): [string, (text: string) => string] => {
  const str = 'module X where\n'
  if (!/^\s*module\s*([\S]*)/.test(text)) {
    const emptySpace = text.match(/\s*/)![0]
    return [str + text, (res) => emptySpace + res.substr(str.length + 1)]
  } else {
    return [text, (res) => res]
  }
}

type Dir = -1 | 1

const getTopLevelRange = (
  document: vscode.TextDocument,
  range: vscode.Range
) => {
  // find none empty
  const findNonEmpty = (index: number, dir: Dir): number => {
    const text = document.lineAt(index).text.trimRight()
    const isEmpty = text === ''
    return isEmpty ? findNonEmpty(index + dir, dir) : index
  }

  const lineCount = document.lineCount
  output.appendLine('lineCount:' + lineCount)

  const findTop = (
    index: number,
    dir: Dir,
    allowOnlyEmpty: boolean
  ): number => {
    if (index >= lineCount - 1) return lineCount - 1

    const text = document.lineAt(index).text.trimRight()
    output.appendLine(['findTop', allowOnlyEmpty, dir, index, text].join(':'))
    const isEmpty = text === ''
    const isNonTop = text.startsWith(' ')

    return allowOnlyEmpty && !isEmpty && isNonTop
      ? -1
      : (isNonTop || isEmpty) && index > 0
      ? findTop(index + dir, dir, allowOnlyEmpty)
      : index
  }

  // find prev(dir: -1)/next(dir: 1) top level string
  const findTopBiDir = (startIndex: number, dir: Dir) => {
    output.appendLine(['findTopBiDir startIndex', startIndex, dir].join(':'))
    // first we try to look up for top level in opposite direction
    const rev = findTop(startIndex, -dir as Dir, true)
    return rev >= 0 ? rev : findTop(startIndex, dir, false)
  }

  const startTopLine = findTopBiDir(range.start.line, -1)
  output.appendLine('startTopLine:' + startTopLine)

  const nextTopLine = findTopBiDir(range.end.line + 2, 1)
  output.appendLine('nextTopLine:' + nextTopLine)

  const endOfBlock = Math.max(startTopLine, findNonEmpty(nextTopLine - 1, -1))

  output.appendLine('endOfBlock:' + endOfBlock)

  return rangeFromLines(document, startTopLine, endOfBlock)
}

const purty = async (
  document: vscode.TextDocument,
  range: vscode.Range
): Promise<string> => {
  const configs = vscode.workspace.getConfiguration('purty')
  // We use empty string to mean unspecified because it means that the setting
  // can be edited without having to write json (`["string", "null"]` does not
  // have this property).
  const purtyCmd = await findPurty(document.fileName, configs.pathToPurty)
  if (purtyCmd == null) {
    vscode.window.showErrorMessage(
      `Error: Could not find location of purty exe.`
    )
    vscode.window.showInformationMessage(
      'Do you have purty installed? (`npm install purty`)'
    )
    vscode.window.showInformationMessage(
      'Or you can specify the full path in settings.'
    )
    return Promise.reject('cannot find purty exe')
  }
  // Quotes make sure any strange characters in the path are escaped (single quotes would
  // be better, but double quotes are more cross-platform (works on windows))
  const cmd = `"${purtyCmd}" -`
  const [text, revert] = geTextToFormat(document.getText(range))
  const cwdCurrent = vscode.workspace.rootPath
  return new Promise((resolve, reject) => {
    const childProcess = exec(
      cmd,
      { cwd: cwdCurrent },
      (err, stdout, stderr) => {
        if (stderr) {
          vscode.window.showErrorMessage(
            'Could not format with purty:' + stderr // + '\nInput' + text
          )
        }
        if (err || stderr) {
          reject(err || stderr)
        }
        resolve(revert(stdout))
      }
    )
    childProcess.stdin!.write(text)
    childProcess.stdin!.end()
  })
}

/// Find the purty executable.
///
/// If a path is passed as an argument that is tested first,
/// then/otherwise the location (<workspace_dir>/node_modules/.bin/purty) is searched,
/// and finally the `PATH` environment variable used for a final search. If no executable
/// is found, then the promise will be rejected.
const findPurty = async (psFilePath: string, purtyPath: string) => {
  if (purtyPath !== '') {
    if (await canRun(purtyPath)) {
      return purtyPath
    }
  }
  const localPurty = await localPurtyPath(psFilePath)
  if (await canRun(localPurty)) {
    return localPurty
  }
  try {
    return await which('purty')
  } catch (_) {}
  return null
}

/// Does an executable at `exePath` exist and is it runnable?
const canRun = async (exePath: string | null) => {
  if (exePath == null) {
    return false
  }
  try {
    await fs.promises.access(exePath, fs.constants.X_OK)
    return true
  } catch (_) {}
  return false
}

/// Get the location that `npm install purty` would install purty to. If no file
/// exists there or it is not executable, return `null`.
const localPurtyPath = async (cwd: string) => {
  try {
    const workspacePath = await pkgUp({ cwd })
    if (!workspacePath) {
      throw 'Could not not get workspace path'
    }
    const purtyPath = path.resolve(
      path.dirname(workspacePath),
      'node_modules',
      '.bin',
      'purty'
    )
    if (await canRun(purtyPath)) {
      return purtyPath
    }
  } catch (_) {}
  return null
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
}
