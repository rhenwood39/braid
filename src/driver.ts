import { SyntaxNode } from './ast';
import { TypeMap, BUILTIN_TYPES, pretty_type } from './type';
import { BUILTIN_OPERATORS, TypeCheck, gen_check } from './type_check';
import { desugar_cross_stage, desugar_macros } from './sugar';
import * as interp from './interp';
import { compose, assign, Gen, scope_eval } from './util';
import { TypeTable, elaborate } from './type_elaborate';
import * as webgl from './backends/webgl';
import * as gl from './backends/gl';
import * as glsl from './backends/glsl';
import * as js from './backends/js';
import { CompilerIR } from './compile/ir';
import { semantically_analyze } from './compile/compile';
import parser = require('../parser');
import { pretty } from './pretty';

// This is a helper library that orchestrates all the parts of the compiler in
// a configurable way. You invoke it by passing continuations through all the
// steps using a configuration object that handles certain events. The steps
// are:
//
// - `frontend`: Parse, typecheck, and desugar. This needs to be done
//   regardless of whether you want to compile or interpret.
// - `interpret`: More or less what it sounds like.
// - `compile`: Compile the checked code to executable code.
// - `execute`: Run the compiled code, hopefully getting the same
//   result as the interpreter would.

/**
 * Configuration for the driver.
 */
export interface Config {
  webgl: boolean;

  // Expect the program to produce a code value, and just produce the
  // read-to-execute generated code.
  generate: boolean;

  parsed: (tree: SyntaxNode) => void;
  typed: (type: string) => void;
  error: (err: string) => void;
  log: (...msg: any[]) => void;

  /**
   * Whether to use the "presplicing" compiler optimization.
   */
  presplice: boolean;
}

function _intrinsics(config: Config): TypeMap {
  if (config.webgl) {
    return gl.INTRINSICS;
  } else {
    return BUILTIN_OPERATORS;
  }
}

function _runtime(config: Config): string {
  let runtime = js.RUNTIME + "\n";
  if (config.webgl) {
    runtime += webgl.RUNTIME + "\n";
  }
  return runtime;
}

function _types(config: Config): TypeMap {
  if (config.webgl) {
    return assign({}, BUILTIN_TYPES, gl.GL_TYPES);
  } else {
    return BUILTIN_TYPES;
  }
}

function _check(config: Config): Gen<TypeCheck> {
  let check = gen_check;
  if (config.webgl) {
    check = compose(glsl.type_mixin, check);
  }
  return check;
}

export function frontend(config: Config, source: string,
    filename: string | null,
    checked: (tree: SyntaxNode, type_table: TypeTable) => void)
{
  // Parse.
  let tree: SyntaxNode;
  try {
    tree = parser.parse(source);
  } catch (e) {
    if (e instanceof parser.SyntaxError) {
      let loc = e.location.start;
      let err = 'parse error at ';
      if (filename) {
        err += filename + ':';
      }
      err += loc.line + ',' + loc.column + ': ' + e.message;
      config.error(err);
      return;
    } else {
      throw e;
    }
  }
  config.log(tree);

  // Check and elaborate types.
  let elaborated: SyntaxNode;
  let type_table: TypeTable;
  try {
    [elaborated, type_table] =
      elaborate(tree, _intrinsics(config), _types(config),
          _check(config));
    let [type, _] = type_table[elaborated.id!];
    config.typed(pretty_type(type));
  } catch (e) {
    config.error(e);
    return;
  }
  config.log('type table', type_table);

  checked(elaborated, type_table);
}

export function compile(config: Config, tree: SyntaxNode,
    type_table: TypeTable, compiled: (code: string) => void)
{
  // Desugar macros.
  let sugarfree = desugar_macros(tree, type_table, _check(config));

  let ir: CompilerIR;
  ir = semantically_analyze(sugarfree, type_table, _intrinsics(config),
                            config.presplice);

  // Log some intermediates.
  config.log('def/use', ir.defuse);
  config.log('progs', ir.progs);
  config.log('procs', ir.procs);
  config.log('main', ir.main);
  config.log('variants', ir.presplice_variants);

  // Compile.
  let jscode: string;
  try {
    if (config.webgl) {
      jscode = webgl.codegen(ir);
    } else {
      jscode = js.codegen(ir);
    }
  } catch (e) {
    if (typeof(e) === "string") {
      config.error(e);
      return;
    } else {
      throw e;
    }
  }

  compiled(jscode);
}

export function interpret(config: Config, tree: SyntaxNode,
    type_table: TypeTable, executed: (result: string) => void)
{
  // Remove cross-stage references and macros.
  let sugarfree = desugar_macros(tree, type_table, _check(config));
  sugarfree = desugar_cross_stage(sugarfree, type_table, _check(config));
  config.log('sugar-free', sugarfree);

  let val = interp.interpret(sugarfree);
  if (config.generate) {
    // Produce an Ssl program.
    executed(interp.pretty_code(val));
  } else {
    // Produce a readable value.
    executed(interp.pretty_value(val));
  }
}

// Get the complete, `eval`-able JavaScript program, including the runtime
// code.
export function full_code(config: Config, jscode: string): string {
  return _runtime(config) + jscode;
}

export function execute(config: Config, jscode: string,
    executed: (result: string) => void)
{
  let res = scope_eval(full_code(config, jscode));
  if (config.webgl) {
    throw "error: driver can't execute WebGL programs";
  }

  if (config.generate) {
    // Produce a JavaScript program (?).
    if (res.prog) {
      if (res.persist.length) {
        throw "error: code has persists";
      } else {
        executed(_runtime(config) + res.prog);
      }
    } else {
      throw "error: program did not produce code";
    }
  } else {
    // Produce a formatted value.
    executed(js.pretty_value(res));
  }
}
