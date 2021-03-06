/**
 * The run-time support library for WebGL programs. This includes both
 * functions that the compiler emits calls to and utilities that the
 * programmer can invoke themselves.
 *
 * In ideal world, this wouldn't be coupled with the dingus, which is really
 * intended to be a UI. I'd like to refactor it into a separate `glrt`
 * component with its own `package.json` to indicate that it's core run-time
 * support for SCC programs. This should be possible with the "dependency"
 * feature slated for TypeScript 2.1:
 * https://github.com/Microsoft/TypeScript/issues/3469
 */

declare function require(name: string): any;

const eye = require('eye-vector');
const mat4 = require('gl-mat4');
const angle_normals = require('angle-normals');
const obj_loader = require('webgl-obj-loader');
const seedrandom = require('seedrandom');

type Vec3Array = [number, number, number][];
type Vec2Array = [number, number][];

/**
 * The type of the sample meshes we use.
 */
interface Mesh {
  positions: Vec3Array;
  cells?: Vec3Array;
  texcoords?: Vec2Array;
  normals?: Vec3Array;
  tangents?: Vec3Array;
};

/**
 * Given a flat array, return an array with the elements grouped into
 * sub-arrays of a given size.
 */
function group_array<T>(a: T[], size: number) {
  let out: T[][] = [];
  for (let i = 0; i < a.length; i += size) {
    out.push(a.slice(i, i + size));
  }
  return out;
}

/**
 * The opposite of `group_array`: flatten an array of arrays to a plain array
 * of the element type.
 */
function flat_array<T>(a: T[][]) {
  let out: T[] = [];
  for (let vec of a) {
    for (let el of vec) {
      out.push(el);
    }
  }
  return out;
}

/**
 * Create and fill a WebGL buffer with a typed array.
 *
 * `mode` should be either `ELEMENT_ARRAY_BUFFER` or `ARRAY_BUFFER`.
 */
function gl_buffer(gl: WebGLRenderingContext, mode: number,
                   data: Float32Array | Uint16Array)
{
  let buf = gl.createBuffer();
  gl.bindBuffer(mode, buf);
  gl.bufferData(mode, data, gl.STATIC_DRAW);
  return buf;
}

/**
 * The kinds of assets we support.
 */
export type Asset = string | HTMLImageElement | ArrayBuffer;

/**
 * Pre-loaded assets, keyed by filename.
 */
export type Assets = { [path: string]: Asset };

/**
 * Get an asset string or throw an error.
 */
function get_asset(assets: Assets, path: string) {
  let asset = assets[path];
  if (!asset) {
    throw `asset not loaded: ${path}`;
  }
  return asset;
}

/**
 * A little stateful wrapper for `seedrandom`.
 */
class Random {
  rng: any;

  constructor() {
    this.seed();
  }

  seed = (s = 'the seed') => {
    this.rng = seedrandom(s);
  }

  /**
   * Floating point boolean coin flip: returns either 1.0 or 0.0.
   */
  flip = () => {
    return this.rng() > 0.5 ? 1.0 : 0.0;
  }
}

/**
 * Simple AJAX wrapper for GET requests.
 */
function ajax(url: string, responseType: "text" | "arraybuffer" | "blob" |
              "document" | "json"): Promise<XMLHttpRequest>
{
  return new Promise((resolve, reject) => {
    let xhr = new XMLHttpRequest();
    xhr.responseType = responseType;
    xhr.onreadystatechange = function () {
      if (xhr.readyState === XMLHttpRequest.DONE) {
        if (xhr.status === 200) {
          resolve(xhr);
        } else {
          let err = "asset loading failed with status " + xhr.status;
          console.error(err);
          reject(err);
        }
      }
    };
    xhr.open("GET", url);
    xhr.send();
  });
}

/**
 * Get data via AJAX as a string.
 */
function ajax_get(url: string): Promise<string> {
  return ajax(url, "text").then((xhr) => xhr.response);
}

/**
 * Get binary data via AJAX>
 */
function ajax_get_binary(url: string): Promise<ArrayBuffer> {
  return ajax(url, "arraybuffer").then((xhr) => xhr.response);
}

/**
 * Image loader with the DOM's `new Image` API.
 */
function image_get(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    let img = new Image();
    img.onload = function() {
      resolve(img);
    }
    img.src = url;
  });
}

/**
 * File extensions to fetch as images.
 */
const IMAGE_EXTENSIONS = ['.jpeg', '.jpg', '.png', '.gif'];

/**
 * File extensions to fetch as binary data.
 */
const BINARY_EXTENSIONS = ['.vtx', '.raw'];

/**
 * Check whether a path seems to be an image.
 */
function has_extension(path: string, extensions: string[]): boolean {
  for (let ext of extensions) {
    let pos = path.length - ext.length;
    if (path.indexOf(ext) === pos) {
      return true;
    }
  }
  return false;
}

/**
 * Load some assets from the server.
 */
export function load_assets(paths: string[], baseurl="assets/"):
  Promise<Assets>
{
  // Kick off async requests for all the assets.
  let requests: Promise<Asset>[] = [];
  for (let path of paths) {
    // Fetch the URL either as an image, binary, or string file.
    let url = baseurl + path;
    if (has_extension(path, IMAGE_EXTENSIONS)) {
      requests.push(image_get(url));
    } else if (has_extension(path, BINARY_EXTENSIONS)) {
      requests.push(ajax_get_binary(url));
    } else {
      requests.push(ajax_get(url));
    }
  }

  // When all return, construct a map from the returned data strings.
  return Promise.all(requests).then((contents) => {
    let assets: Assets = {};
    for (let i = 0; i < paths.length; ++i) {
      assets[paths[i]] = contents[i];
    }
    return assets;
  });
}

/**
 * Parse the `.vtx.raw` mesh data format converted from the Spire examples.
 *
 * Format notes:
 *
 * > 44 bytes for each vertex.
 * > Position: vec3 (byte 0-11)
 * > Normal: vec3 (byte 12-23)
 * > Tangent: vec3 (byte 24-35)
 * > UV: vec2 (byte 36-43)
 *
 * This current version turns the raw data into inefficient JavaScript arrays,
 * just for uniformity. Eventually, it would be nice to keep this data as
 * binary.
 */
function parse_vtx_raw(buffer: ArrayBuffer): Mesh {
  let offset = 0;
  let array = new Float32Array(buffer);

  // Read `count` floats from the array and advance the offset accordingly.
  // Return an ordinary JavaScript array.
  function read_floats(count: number): number[] {
    let out = array.slice(offset, offset + count);
    offset += count;
    return Array.prototype.slice.call(out);
  }

  // Type-safety helpers for reading vectors of fixed sizes.
  function read_vec3() {
    return read_floats(3) as [number, number, number];
  }
  function read_vec2() {
    return read_floats(2) as [number, number];
  }

  // Read the attributes for each vertex.
  let positions: Vec3Array = [];
  let normals: Vec3Array = [];
  let tangents: Vec3Array = [];
  let texcoords: Vec2Array = [];
  while (offset < array.length) {
    positions.push(read_vec3());
    normals.push(read_vec3());
    tangents.push(read_vec3());
    texcoords.push(read_vec2());
  }
  return {
    positions,
    normals,
    tangents,
    texcoords,
  };
}

/**
 * Access an image asset.
 */
function load_image(assets: Assets, name: string): HTMLImageElement {
  let img = get_asset(assets, name);
  if (img instanceof HTMLImageElement) {
    return img;
  } else {
    throw "non-image used as image";
  }
}

/**
 * Convert an image into a WebGL texture.
 */
function texture(gl: WebGLRenderingContext, img: HTMLImageElement) {
  let tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);

  // Invert the Y-coordinate. I'm not 100% sure why this is necessary,
  // but it appears to have been invented to convert between the DOM
  // coordinate convention for images and WebGL's convention.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                gl.UNSIGNED_BYTE, img);

  // Interpolation.
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);

  // "Wrap around" the texture on overrun.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  gl.bindTexture(gl.TEXTURE_2D, null);  // Unbind.

  return tex;
}

/**
 * Get the run-time values to expose to WebGL programs.
 *
 * `gl` is the rendering context. `assets` are the pre-loaded data files.
 * `drawtime` is a callback that is invoked with performance information
 * whenever an object is drawn.
 */
export function runtime(gl: WebGLRenderingContext, assets: Assets,
                        drawtime: (ms: number) => void) {
  return {
    // Operations exposed to the language for getting data for meshes as WebGL
    // buffers.
    mesh_indices(obj: Mesh) {
      if (!obj.cells) {
        throw "mesh has no indices";
      }
      let data = flat_array(obj.cells);
      return gl_buffer(gl, gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(data));
    },

    mesh_positions(obj: Mesh) {
      let data = flat_array(obj.positions);
      return gl_buffer(gl, gl.ARRAY_BUFFER, new Float32Array(data));
    },

    mesh_normals(obj: Mesh) {
      // Some mesh formats come with normals. Others need them to be
      // calculated.
      let norm: Vec3Array;
      if (obj.normals) {
        norm = obj.normals;
      } else {
        norm = angle_normals(obj.cells, obj.positions);
      }

      let data = flat_array(norm);
      return gl_buffer(gl, gl.ARRAY_BUFFER, new Float32Array(data));
    },

    mesh_tangents(obj: Mesh) {
      if (!obj.tangents) {
        throw "mesh has no tangents";
      }
      let data = flat_array(obj.tangents);
      return gl_buffer(gl, gl.ARRAY_BUFFER, new Float32Array(data));
    },

    // The size, in scalar numbers, of the index array.
    mesh_size(obj: Mesh) {
      return obj.cells!.length * obj.cells![0].length;
    },

    // The size, in scalar numbers, of the vertex position array.
    mesh_count(obj: Mesh) {
      return obj.positions.length * obj.positions[0].length;
    },

    mesh_texcoords(obj: Mesh) {
      let coords = obj.texcoords;
      if (!coords) {
        throw "mesh does not have texture coordinates";
      }

      // Create a WebGL buffer.
      let data = flat_array(coords);
      return gl_buffer(gl, gl.ARRAY_BUFFER, new Float32Array(data));
    },

    // And, similarly, a function for actually drawing a mesh. This takes the
    // indices buffer for the mesh and its size (in the number of scalars).
    draw_mesh(indices: WebGLBuffer, size: number) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
      let start = performance.now();
      gl.drawElements(gl.TRIANGLES, size, gl.UNSIGNED_SHORT, 0);
      let end = performance.now();
      drawtime(end - start);
    },

    // An alternative to `draw_mesh` for using `glDrawArrays`, i.e., without
    // an explicit vertex indices. `size` is the number of primitives to draw
    // (I think).
    draw_arrays(size: number) {
      let start = performance.now();
      gl.drawArrays(gl.TRIANGLES, 0, size / 3);
      let end = performance.now();
      drawtime(end - start);
    },

    // Matrix manipulation library.
    mat4,

    // Eye vector calculation.
    eye,

    // Load a mesh from an OBJ file.
    load_obj(name: string) {
      let obj_src = get_asset(assets, name);
      let mesh = new obj_loader.Mesh(obj_src);

      // Match the interface we're using for Mesh objects that come from
      // StackGL.
      let out: Mesh = {
        positions: group_array(mesh.vertices, 3) as Vec3Array,
        cells: group_array(mesh.indices, 3) as Vec3Array,

        // This name I invented -- it's not in the StackGL models.
        texcoords: group_array(mesh.textures, 2) as Vec3Array,
      };

      // .obj files can have normals, but if they don't, this parser library
      // (confusingly) fills the array with NaN.
      if (!isNaN(mesh.vertexNormals[0])) {
        out.normals = group_array(mesh.vertexNormals, 3) as Vec3Array;
      }

      return out;
    },

    /**
     * Load an image asset.
     */
    load_image(name: string) {
      return load_image(assets, name);
    },

    /**
     * Convert an image to a texture.
     */
    texture(img: HTMLImageElement) {
      return texture(gl, img);
    },

    /**
     * Load an image asset as a WebGL texture object.
     */
    load_texture(name: string) {
      let img = load_image(assets, name);
      return texture(gl, img);
    },

    /**
     * Load a mesh from a `.vtx.raw` file (from the Spire examples).
     */
    load_raw(name: string) {
      let buffer = get_asset(assets, name);
      if (buffer instanceof ArrayBuffer) {
        return parse_vtx_raw(buffer);
      } else {
        throw "non-binary data used as raw mesh";
      }
    },

    /**
     * Create a buffer of values.
     */
    float_array() {
      let arr = new Float32Array(arguments);

      let buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);

      return buf;
    },

    /**
     * Get an average color from a texture.
     */
    average(img: HTMLImageElement) {
      // Apparently, this is the only way to access the image data from an
      // <img> element.
      let canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      let context = canvas.getContext('2d');
      if (!context) {
        console.error("could not get canvas context");
        return;
      }
      context.drawImage(img, 0, 0, img.width, img.height);
      let data = context.getImageData(0, 0, img.width, img.height).data;

      // Sum the pixels.
      let totals = [0, 0, 0, 0];  // Red, green, blue, alpha.
      let offset = 0;
      for (let x = 0; x < img.width; ++x) {
        for (let y = 0; y < img.height; ++y) {
          for (let i = 0; i < 4; ++i) {
            totals[i] += data[offset + i];
          }
          offset += 4;
        }
      }

      // Average.
      let count = img.width * img.height;
      let averages: number[] = [];
      for (let i = 0; i < 4; ++i) {
        averages[i] = totals[i] / 255 / count;
      }
      return averages;
    },

    /**
     * Random numbers (with a seed).
     */
    random: new Random(),
  };
}
