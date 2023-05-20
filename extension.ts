import { exec } from 'child_process'
import fs from 'fs'
import path from 'path'
import pkgUp from 'pkg-up'
import vscode from 'vscode'
import which from 'which'

const { formatDefault } = require('purs-top-level-format')

type Formatter = {
  name: string
  bin: string
  formatCmd: string | null
  installInstruction: string
}

const formatters: { [N in string]: Formatter } = {
  purty: {
    name: 'purty',
    bin: 'purty',
    formatCmd: '-',
    installInstruction:
      'Do you have prettier and pose plugin installed? (`npm install --save-dev prettier @rowtype-yoga/prettier-plugin-purescript`)',
  },
  pose: {
    name: 'pose',
    bin: 'prettier',
    formatCmd: '--stdin-filepath __dummy__format__.purs',
    installInstruction:
      'Do you have pose installed? (`npm install purty [-g]`)',
  },
  tidy: {
    name: 'tidy',
    bin: 'purs-tidy',
    formatCmd: 'format',
    installInstruction:
      'Do you have purs-tidy installed? (`npm install purs-tidy [-g]`)',
  },
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
        provideDocumentFormattingEdits: (doc) => justFormat(doc),
      }
    ),
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      { scheme: 'file', language: 'purescript' },
      {
        provideDocumentRangeFormattingEdits: (doc, range) =>
          justFormat(doc, range),
      }
    )
  )
}

const rangeFromLines = (
  document: vscode.TextDocument,
  startLine: number,
  endLine: number
) => {
  const endLineReal = Math.max(0, Math.min(document.lineCount - 1, endLine))
  const start = new vscode.Position(startLine, 0)
  return new vscode.Range(
    start,
    startLine > endLine
      ? start
      : new vscode.Position(
          endLineReal,
          Math.max(0, document.lineAt(endLineReal).text.length)
        )
  )
}

const normalizeSelectedTextRange = (
  document: vscode.TextDocument,
  range: vscode.Range
) => rangeFromLines(document, range.start.line, range.end.line)

const getSymbolsCount = (text: string) => {
  return text.replace(/\s/g, '').length
}

const isWhiteSpace = (ch: string) => ch === ' '

// positive count: remove (shift) <-- from right to left (from the end)
// negative count: remove (shift) --> from left to right (from the beginning)
const removeSymbolsFromLine = (str: string, count: number) => {
  if (count === 0) return str
  const chars = str.split('')
  const r =
    count > 0
      ? chars.reduceRight(
          (p, ch) => {
            return {
              // skip chars at the end
              res: p.count > 0 ? '' : ch + p.res,
              count: p.count - (isWhiteSpace(ch) ? 0 : 1),
            }
          },
          { res: '', count }
        )
      : chars.reduce(
          (p, ch) => {
            return {
              // skip chars at the beginning
              res: p.count <= 0 ? '' : p.res + ch,
              count: p.count + (isWhiteSpace(ch) ? 0 : 1),
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
  const lines = text.split('\n')

  const chars = lines
    .map((s) => s.trim())
    .join('\n')
    .split('')
  const isNewLine = (ch: string) => ch === '\n'
  const getLine = (dir: 1 | -1, count: number) => {
    const method = dir === 1 ? 'reduce' : 'reduceRight'

    const [startLine] = dir === 1 ? [0, 0] : [lines.length - 1]

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
      { count: 0, line: startLine, chars: 0 }
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
  return removeSymbolsFromLine(text, charsToRemove).split('\n')
}

const debugOutput = (str: string) => output.appendLine(str)

const justFormat = (
  document: vscode.TextDocument,
  selRange?: vscode.Range
): Promise<vscode.TextEdit[]> => {
  const configuration = vscode.workspace.getConfiguration()

  const config = {
    ...defaultConfig,
    ...configuration.get<Config>('purescript.topLevelFormat'),
  }

  debugOutput('config: ' + JSON.stringify(config))

  const formatterName = config.formatter
  const formatter =
    config.customFormatter ||
    (formatterName ? formatters[formatterName] : false)

  if (!formatter || !selRange) {
    const text = document.getText()
    if (formatter && !config.onlySelection) {
      return runFormatter(formatter, text, document.fileName).then(
        (formatted) => {
          return [
            vscode.TextEdit.replace(
              getDocRange(document),
              formatDefault(formatted)
            ),
          ]
        }
      )
    } else {
      debugOutput('Formatting whole document')
      return Promise.resolve([
        vscode.TextEdit.replace(getDocRange(document), formatDefault(text)),
      ])
    }
  }

  debugOutput('Getting top range')

  const range = normalizeSelectedTextRange(document, selRange)

  debugOutput('range')
  const topRange = getTopLevelRange(document, range)

  debugOutput(
    [
      'Top range (lines)',
      [topRange.start.line, topRange.start.character].join(':'),
      [topRange.end.line, topRange.end.character].join(':'),
    ].join(' ')
  )

  // lines before selected
  const textBeforeSelected = document.getText(
    rangeFromLines(document, topRange.start.line, range.start.line - 1)
  )

  // do not include last line of the selection if not chars selected there
  const rangeEndLine =
    range.end.character === 0 ? Math.max(0, range.end.line - 1) : range.end.line

  debugOutput('rangeEndLine: ' + rangeEndLine)

  const textAfterSelected = document.getText(
    rangeFromLines(document, rangeEndLine + 1, topRange.end.line)
  )

  const [text, revert] = geTextToFormat(document.getText(topRange))

  // format a whole top level blocks referred to selection
  return runFormatter(formatter, text, document.fileName)
    .then((formattedRes) => {
      const formatted = revert(formattedRes)

      output.appendLine('formatted:\n' + formatted)

      const symLines = findLineSymCount(
        formatted,
        getSymbolsCount(textBeforeSelected),
        getSymbolsCount(textAfterSelected)
      )

      output.appendLine('symLines:' + JSON.stringify(symLines))
      output.appendLine('formatted lines: ' + formatted.split('\n').length)
      // extract from the formatted piece
      // lines that will be replaced in the code
      const formattedCutLines = formatted
        .split('\n')
        .slice(symLines.start.line, symLines.end.line + 1)

      const beforeLines =
        textBeforeSelected.length > 1
          ? removeCharsAndSplit(textBeforeSelected, symLines.start.chars)
          : []
      output.appendLine('beforeLines: ' + beforeLines.length)

      output.appendLine(
        'textBeforeSelected.length: ' + textBeforeSelected.length
      )

      output.appendLine(
        `textBeforeSelected(${getSymbolsCount(textBeforeSelected)}):\n` +
          textBeforeSelected
      )
      output.appendLine(
        `textAfterSelected(${getSymbolsCount(textAfterSelected)}):\n` +
          textAfterSelected
      )

      const afterLines = textAfterSelected
        ? removeCharsAndSplit(textAfterSelected, symLines.end.chars)
        : []

      output.appendLine('afterLines: ' + afterLines.length)
      output.appendLine('afterLines text: ' + afterLines)

      output.appendLine('formattedCut lines: ' + formattedCutLines.length)
      output.appendLine('formattedCut:\n' + formattedCutLines.join('\n'))

      const topWithFormattedCut = [
        ...beforeLines,
        ...formattedCutLines,
        ...afterLines,
      ].join('\n')

      output.appendLine(
        'topWithFormattedCut lines: ' + topWithFormattedCut.split('\n').length
      )
      output.appendLine('topWithFormattedCut:\n' + topWithFormattedCut)
      output.appendLine('<-- topWithFormattedCut end.')

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
    return [str + text, (res) => emptySpace + res.substr(str.length)]
  } else {
    return [text, (res) => res]
  }
}

type Dir = -1 | 1

// gets whole top block(s) selection, which to actually selected range refer
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

  // finds top line declaration moves in dir - up (-1), down (1)
  const findTop = (
    index: number,
    dir: Dir,
    allowOnlyEmpty: boolean
  ): number => {
    // we may return illegal lineCount number, but it is ok
    if (index > lineCount - 1) return lineCount

    const text = document.lineAt(index).text.trimRight()
    // output.appendLine(['findTop', allowOnlyEmpty, dir, index, text].join(':'))
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
    output.appendLine(
      ['findTopBiDir startIndex:', startIndex, ' dir:', dir].join(' ')
    )
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

type Config = {
  formatter?: 'purty' | 'tidy' | 'pose'
  customFormatter?: Formatter
  onlySelection?: boolean
}

const defaultFormatter = 'tidy'

const defaultConfig: Config = {
  formatter: defaultFormatter,
  onlySelection: false,
}

const runFormatter = async (
  formatter: Formatter,
  text: string,
  filePath: string
): Promise<string> => {
  output.appendLine('Using formatter bin: ' + formatter.bin)

  // We use empty string to mean unspecified because it means that the setting
  // can be edited without having to write json (`["string", "null"]` does not
  // have this property).
  const formatterCmd = await findFormatter(formatter, filePath, formatter.bin)

  if (formatterCmd == null) {
    vscode.window.showErrorMessage(
      `Error: Could not find location of formatter binary: ${formatter.bin}`
    )
    vscode.window.showInformationMessage(formatter.installInstruction)

    return Promise.reject(`cannot find ${formatter.bin} binary`)
  }

  const cmdAdd = formatter.formatCmd ? ' ' + formatter.formatCmd : ''
  // Quotes make sure any strange characters in the path are escaped (single quotes would
  // be better, but double quotes are more cross-platform (works on windows))
  const cmd = `"${formatterCmd}"` + cmdAdd

  const cwdCurrent = vscode.workspace.rootPath
  return new Promise((resolve, reject) => {
    output.appendLine('running: ' + cmd)
    const childProcess = exec(
      cmd,
      { cwd: cwdCurrent },
      (err, stdout, stderr) => {
        if (stderr) {
          vscode.window.showErrorMessage(
            `Could not format using ${formatter.name} formatter:` + stderr // + '\nInput' + text
          )
        }
        if (err || stderr) {
          reject(err || stderr)
        }
        resolve(stdout)
      }
    )
    childProcess.on('error', (err) => {
      output.appendLine('childProcess error: ' + err.message)
    })
    output.appendLine('writing text\n' + text)
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
const findFormatter = async (
  formatter: Formatter,
  psFilePath: string,
  purtyPath: string
) => {
  if (purtyPath !== '') {
    if (await canRun(purtyPath)) {
      return purtyPath
    }
  }
  const localPurty = await localFormatterPath(formatter.bin, psFilePath)
  if (await canRun(localPurty)) {
    return localPurty
  }
  try {
    return await which(formatter.bin)
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
const localFormatterPath = async (binName: string, cwd: string) => {
  try {
    const workspacePath = await pkgUp({ cwd })
    if (!workspacePath) {
      throw 'Could not not get workspace path'
    }
    const purtyPath = path.resolve(
      path.dirname(workspacePath),
      'node_modules',
      '.bin',
      binName
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
