"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JSONBindingsBuilder = exports.isEntry = exports.toString = void 0;
const as_1 = require("visitor-as/as");
const visitor_as_1 = require("visitor-as");
const utils_1 = require("./utils");
const NEAR_DECORATOR = "nearBindgen";
function returnsVoid(node) {
    return toString(node.signature.returnType) === "void";
}
function numOfParameters(node) {
    return node.signature.parameters.length;
}
function hasNearDecorator(stmt) {
    return ((stmt.text.includes("@nearfile") || stmt.text.includes("@" + NEAR_DECORATOR) || isEntry(stmt)) &&
        !stmt.text.includes("@notNearfile"));
}
function toString(node) {
    return visitor_as_1.ASTBuilder.build(node);
}
exports.toString = toString;
function isEntry(source) {
    return source.range.source.sourceKind == as_1.SourceKind.USER_ENTRY;
}
exports.isEntry = isEntry;
function isClass(type) {
    return type.kind == as_1.NodeKind.CLASSDECLARATION;
}
function isField(mem) {
    return mem.kind == as_1.NodeKind.FIELDDECLARATION;
}
function createDecodeStatements(_class) {
    return _class.members
        .filter(isField)
        .map((field) => {
        const name = toString(field.name);
        return (createDecodeStatement(field, `this.${name} = obj.has("${name}") ? `) +
            `: ${field.initializer != null ? toString(field.initializer) : `this.${name}`};`);
    });
}
function createDecodeStatement(field, setterPrefix = "") {
    let T = toString(field.type);
    let name = toString(field.name);
    return `${setterPrefix}decode<${T}, JSON.Obj>(obj, "${name}")`;
}
function createEncodeStatements(_class) {
    return _class.members
        .filter(isField)
        .map((field) => {
        let T = toString(field.type);
        let name = toString(field.name);
        return `encode<${T}, JSONEncoder>(this.${name}, "${name}", encoder);`;
    });
}
// TODO: Extract this into separate module, preferrable pluggable
class JSONBindingsBuilder extends visitor_as_1.BaseVisitor {
    constructor() {
        super(...arguments);
        this.sb = [];
        this.exportedClasses = new Map();
        this.wrappedFuncs = new Set();
    }
    static build(source) {
        return new JSONBindingsBuilder().build(source);
    }
    static nearFiles(sources) {
        return sources.filter(hasNearDecorator);
    }
    visitClassDeclaration(node) {
        if (!this.exportedClasses.has(toString(node.name))) {
            this.exportedClasses.set(toString(node.name), node);
        }
        super.visitClassDeclaration(node);
    }
    visitFunctionDeclaration(node) {
        if (!isEntry(node) ||
            this.wrappedFuncs.has(toString(node.name)) ||
            !node.is(as_1.CommonFlags.EXPORT) ||
            (numOfParameters(node) == 0 && returnsVoid(node))) {
            super.visitFunctionDeclaration(node);
            return;
        }
        this.generateWrapperFunction(node);
        // Change function to not be an export
        node.flags = node.flags ^ as_1.CommonFlags.EXPORT;
        this.wrappedFuncs.add(toString(node.name));
        super.visit(node);
    }
    /*
    Create a wrapper function that will be export in the function's place.
    */
    generateWrapperFunction(func) {
        let signature = func.signature;
        let params = signature.parameters;
        let returnType = signature.returnType;
        let returnTypeName = toString(returnType)
            .split("|")
            .map(name => name.trim())
            .filter(name => name !== "null")
            .join("|");
        let hasNull = toString(returnType).includes("null");
        let name = func.name.text;
        this.sb.push(`function __wrapper_${name}(): void {`);
        if (params.length > 0) {
            this.sb.push(`  const obj = getInput();`);
        }
        if (toString(returnType) !== "void") {
            this.sb.push(`  let result: ${toString(returnType)} = ${name}(`);
        }
        else {
            this.sb.push(`  ${name}(`);
        }
        if (params.length > 0) {
            this.sb[this.sb.length - 1] += params
                .map(param => createDecodeStatement(param))
                .join(", ");
        }
        this.sb[this.sb.length - 1] += ");";
        if (toString(returnType) !== "void") {
            this.sb.push(`  const val = encode<${returnTypeName}>(${hasNull ? `changetype<${returnTypeName}>(result)` : "result"});
  value_return(val.byteLength, val.dataStart);`);
        }
        this.sb.push(`}
export { __wrapper_${name} as ${name} }`);
    }
    typeName(type) {
        if (!isClass(type)) {
            return toString(type);
        }
        type = type;
        let className = toString(type.name);
        if (type.isGeneric) {
            className += "<" + type.typeParameters.map(toString).join(", ") + ">";
        }
        return className;
    }
    build(source) {
        const isNearFile = source.text.includes("@nearfile");
        this.sb = [];
        this.visit(source);
        let sourceText = source.statements.map(stmt => {
            let str;
            if (isClass(stmt) &&
                (visitor_as_1.utils.hasDecorator(stmt, NEAR_DECORATOR) || isNearFile)) {
                let _class = stmt;
                let fields = _class.members
                    .filter(isField)
                    .map((field) => field);
                if (fields.some((field) => field.type == null)) {
                    throw new Error("All Fields must have explict type declaration.");
                }
                fields.forEach(field => {
                    if (field.initializer == null) {
                        field.initializer = utils_1.SimpleParser.parseExpression(`defaultValue<${toString(field.type)}>())`);
                    }
                });
                str = toString(stmt);
                str = str.slice(0, str.lastIndexOf("}"));
                let className = this.typeName(_class);
                if (!visitor_as_1.utils.hasDecorator(stmt, NEAR_DECORATOR)) {
                    console.error("\x1b[31m", `@nearfile is deprecated use @${NEAR_DECORATOR} decorator on ${className}`, "\x1b[0m");
                }
                str += `
  decode<_V = Uint8Array>(buf: _V): ${className} {
    let json: JSON.Obj;
    if (buf instanceof Uint8Array) {
      json = JSON.parse(buf);
    } else {
      assert(buf instanceof JSON.Obj, "argument must be Uint8Array or Json Object");
      json = <JSON.Obj> buf;
    }
    return this._decode(json);
  }

  static decode(buf: Uint8Array): ${className} {
    return decode<${className}>(buf);
  }

  private _decode(obj: JSON.Obj): ${className} {
    ${createDecodeStatements(_class).join("\n    ")}
    return this;
  }

  _encode(name: string | null = "", _encoder: JSONEncoder | null = null): JSONEncoder {
    let encoder = _encoder == null ? new JSONEncoder() : _encoder;
    encoder.pushObject(name);
    ${createEncodeStatements(_class).join("\n    ")}
    encoder.popObject();
    return encoder;
  }
  encode(): Uint8Array {
    return this._encode().serialize();
  }

  serialize(): Uint8Array {
    return this.encode();
  }

  toJSON(): string {
    return this._encode().toString();
  }
}`;
            }
            else {
                str = toString(stmt);
            }
            return str;
        });
        return sourceText.concat(this.sb).join("\n");
    }
}
exports.JSONBindingsBuilder = JSONBindingsBuilder;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiSlNPTkJ1aWxkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvSlNPTkJ1aWxkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsc0NBZXVCO0FBQ3ZCLDJDQUEyRDtBQUMzRCxtQ0FBdUM7QUFFdkMsTUFBTSxjQUFjLEdBQUcsYUFBYSxDQUFBO0FBRXBDLFNBQVMsV0FBVyxDQUFDLElBQXlCO0lBQzVDLE9BQU8sUUFBUSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFDLEtBQUssTUFBTSxDQUFDO0FBQ3hELENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxJQUF5QjtJQUNoRCxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQztBQUMxQyxDQUFDO0FBRUQsU0FBUyxnQkFBZ0IsQ0FBQyxJQUFZO0lBQ3BDLE9BQU8sQ0FDTCxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsR0FBRyxjQUFjLENBQUMsSUFBSSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDOUYsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsQ0FDcEMsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFnQixRQUFRLENBQUMsSUFBVTtJQUNqQyxPQUFPLHVCQUFVLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ2hDLENBQUM7QUFGRCw0QkFFQztBQUVELFNBQWdCLE9BQU8sQ0FBQyxNQUFxQjtJQUMzQyxPQUFPLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVUsSUFBSSxlQUFVLENBQUMsVUFBVSxDQUFDO0FBQ2pFLENBQUM7QUFGRCwwQkFFQztBQUVELFNBQVMsT0FBTyxDQUFDLElBQVU7SUFDekIsT0FBTyxJQUFJLENBQUMsSUFBSSxJQUFJLGFBQVEsQ0FB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RUFlakQsQ0FBQzthQUNJO2lCQUFNO2dCQUNMLEdBQUcsR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7YUFDdEI7WUFDRCxPQUFPLEdBQUcsQ0FBQztRQUNiLENBQUMsQ0FBQyxDQUFDO1FBQ0gsT0FBTyxVQUFVLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDL0MsQ0FBQztDQUNGO0FBbktELGtEQW1LQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7XG4gIE5vZGUsXG4gIEZ1bmN0aW9uRGVjbGFyYXRpb24sXG4gIE5vZGVLaW5kLFxuICBTb3VyY2UsXG4gIFNvdXJjZUtpbmQsXG4gIFR5cGVOb2RlLFxuICBDbGFzc0RlY2xhcmF0aW9uLFxuICBEZWNsYXJhdGlvblN0YXRlbWVudCxcbiAgUGFyc2VyLFxuICBDb21tb25GbGFncyxcbiAgRmllbGREZWNsYXJhdGlvbixcbiAgUGFyYW1ldGVyTm9kZSxcbiAgRXhwcmVzc2lvbixcbiAgVG9rZW5pemVyLFxufSBmcm9tIFwidmlzaXRvci1hcy9hc1wiO1xuaW1wb3J0IHsgQVNUQnVpbGRlciwgQmFzZVZpc2l0b3IsIHV0aWxzfSBmcm9tIFwidmlzaXRvci1hc1wiO1xuaW1wb3J0IHsgU2ltcGxlUGFyc2VyIH0gZnJvbSAnLi91dGlscyc7XG5cbmNvbnN0IE5FQVJfREVDT1JBVE9SID0gXCJuZWFyQmluZGdlblwiXG5cbmZ1bmN0aW9uIHJldHVybnNWb2lkKG5vZGU6IEZ1bmN0aW9uRGVjbGFyYXRpb24pOiBib29sZWFuIHtcbiAgcmV0dXJuIHRvU3RyaW5nKG5vZGUuc2lnbmF0dXJlLnJldHVyblR5cGUpID09PSBcInZvaWRcIjtcbn1cblxuZnVuY3Rpb24gbnVtT2ZQYXJhbWV0ZXJzKG5vZGU6IEZ1bmN0aW9uRGVjbGFyYXRpb24pOiBudW1iZXIge1xuICByZXR1cm4gbm9kZS5zaWduYXR1cmUucGFyYW1ldGVycy5sZW5ndGg7XG59XG5cbmZ1bmN0aW9uIGhhc05lYXJEZWNvcmF0b3Ioc3RtdDogU291cmNlKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgKHN0bXQudGV4dC5pbmNsdWRlcyhcIkBuZWFyZmlsZVwiKSB8fCBzdG10LnRleHQuaW5jbHVkZXMoXCJAXCIgKyBORUFSX0RFQ09SQVRPUikgfHwgaXNFbnRyeShzdG10KSkgJiZcbiAgICAhc3RtdC50ZXh0LmluY2x1ZGVzKFwiQG5vdE5lYXJmaWxlXCIpXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0b1N0cmluZyhub2RlOiBOb2RlKTogc3RyaW5nIHtcbiAgcmV0dXJuIEFTVEJ1aWxkZXIuYnVpbGQobm9kZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0VudHJ5KHNvdXJjZTogU291cmNlIHwgTm9kZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gc291cmNlLnJhbmdlLnNvdXJjZS5zb3VyY2VLaW5kID09IFNvdXJjZUtpbmQuVVNFUl9FTlRSWTtcbn1cblxuZnVuY3Rpb24gaXNDbGFzcyh0eXBlOiBOb2RlKTogYm9vbGVhbiB7XG4gIHJldHVybiB0eXBlLmtpbmQgPT0gTm9kZUtpbmQuQ0xBU1NERUNMQVJBVElPTjtcbn1cblxuZnVuY3Rpb24gaXNGaWVsZChtZW06IERlY2xhcmF0aW9uU3RhdGVtZW50KSB7XG4gIHJldHVybiBtZW0ua2luZCA9PSBOb2RlS2luZC5GSUVMRERFQ0xBUkFUSU9OO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVEZWNvZGVTdGF0ZW1lbnRzKF9jbGFzczogQ2xhc3NEZWNsYXJhdGlvbik6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIF9jbGFzcy5tZW1iZXJzXG4gICAgLmZpbHRlcihpc0ZpZWxkKVxuICAgIC5tYXAoKGZpZWxkOiBGaWVsZERlY2xhcmF0aW9uKTogc3RyaW5nID0+IHtcbiAgICAgIGNvbnN0IG5hbWUgPSB0b1N0cmluZyhmaWVsZC5uYW1lKTtcbiAgICAgIHJldHVybiAoXG4gICAgICAgIGNyZWF0ZURlY29kZVN0YXRlbWVudChmaWVsZCwgYHRoaXMuJHtuYW1lfSA9IG9iai5oYXMoXCIke25hbWV9XCIpID8gYCkgK1xuICAgICAgICBgOiAke2ZpZWxkLmluaXRpYWxpemVyICE9IG51bGwgPyB0b1N0cmluZyhmaWVsZC5pbml0aWFsaXplcikgOiBgdGhpcy4ke25hbWV9YH07YFxuICAgICAgKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRGVjb2RlU3RhdGVtZW50KFxuICBmaWVsZDogRmllbGREZWNsYXJhdGlvbiB8IFBhcmFtZXRlck5vZGUsXG4gIHNldHRlclByZWZpeDogc3RyaW5nID0gXCJcIlxuKTogc3RyaW5nIHtcbiAgbGV0IFQgPSB0b1N0cmluZyhmaWVsZC50eXBlISk7XG4gIGxldCBuYW1lID0gdG9TdHJpbmcoZmllbGQubmFtZSk7XG4gIHJldHVybiBgJHtzZXR0ZXJQcmVmaXh9ZGVjb2RlPCR7VH0sIEpTT04uT2JqPihvYmosIFwiJHtuYW1lfVwiKWA7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUVuY29kZVN0YXRlbWVudHMoX2NsYXNzOiBDbGFzc0RlY2xhcmF0aW9uKTogc3RyaW5nW10ge1xuICByZXR1cm4gX2NsYXNzLm1lbWJlcnNcbiAgICAuZmlsdGVyKGlzRmllbGQpXG4gICAgLm1hcCgoZmllbGQ6IEZpZWxkRGVjbGFyYXRpb24pOiBzdHJpbmcgPT4ge1xuICAgICAgbGV0IFQgPSB0b1N0cmluZyhmaWVsZC50eXBlISk7XG4gICAgICBsZXQgbmFtZSA9IHRvU3RyaW5nKGZpZWxkLm5hbWUpO1xuICAgICAgcmV0dXJuIGBlbmNvZGU8JHtUfSwgSlNPTkVuY29kZXI+KHRoaXMuJHtuYW1lfSwgXCIke25hbWV9XCIsIGVuY29kZXIpO2A7XG4gICAgfSk7XG59XG5cbi8vIFRPRE86IEV4dHJhY3QgdGhpcyBpbnRvIHNlcGFyYXRlIG1vZHVsZSwgcHJlZmVycmFibGUgcGx1Z2dhYmxlXG5leHBvcnQgY2xhc3MgSlNPTkJpbmRpbmdzQnVpbGRlciBleHRlbmRzIEJhc2VWaXNpdG9yIHtcbiAgcHJpdmF0ZSBzYjogc3RyaW5nW10gPSBbXTtcbiAgcHJpdmF0ZSBleHBvcnRlZENsYXNzZXM6IE1hcDxzdHJpbmcsIENsYXNzRGVjbGFyYXRpb24+ID0gbmV3IE1hcCgpO1xuICB3cmFwcGVkRnVuY3M6IFNldDxzdHJpbmc+ID0gbmV3IFNldCgpO1xuXG4gIHN0YXRpYyBidWlsZChzb3VyY2U6IFNvdXJjZSk6IHN0cmluZyB7XG4gICAgcmV0dXJuIG5ldyBKU09OQmluZGluZ3NCdWlsZGVyKCkuYnVpbGQoc291cmNlKTtcbiAgfVxuXG4gIHN0YXRpYyBuZWFyRmlsZXMoc291cmNlczogU291cmNlW10pOiBTb3VyY2VbXSB7XG4gICAgcmV0dXJuIHNvdXJjZXMuZmlsdGVyKGhhc05lYXJEZWNvcmF0b3IpO1xuICB9XG5cbiAgdmlzaXRDbGFzc0RlY2xhcmF0aW9uKG5vZGU6IENsYXNzRGVjbGFyYXRpb24pOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuZXhwb3J0ZWRDbGFzc2VzLmhhcyh0b1N0cmluZyhub2RlLm5hbWUpKSkge1xuICAgICAgdGhpcy5leHBvcnRlZENsYXNzZXMuc2V0KHRvU3RyaW5nKG5vZGUubmFtZSksIG5vZGUpO1xuICAgIH1cbiAgICBzdXBlci52aXNpdENsYXNzRGVjbGFyYXRpb24obm9kZSk7XG4gIH1cblxuICB2aXNpdEZ1bmN0aW9uRGVjbGFyYXRpb24obm9kZTogRnVuY3Rpb25EZWNsYXJhdGlvbik6IHZvaWQge1xuICAgIGlmIChcbiAgICAgICFpc0VudHJ5KG5vZGUpIHx8XG4gICAgICB0aGlzLndyYXBwZWRGdW5jcy5oYXModG9TdHJpbmcobm9kZS5uYW1lKSkgfHxcbiAgICAgICFub2RlLmlzKENvbW1vbkZsYWdzLkVYUE9SVCkgfHxcbiAgICAgIChudW1PZlBhcmFtZXRlcnMobm9kZSkgPT0gMCAmJiByZXR1cm5zVm9pZChub2RlKSlcbiAgICApIHtcbiAgICAgIHN1cGVyLnZpc2l0RnVuY3Rpb25EZWNsYXJhdGlvbihub2RlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5nZW5lcmF0ZVdyYXBwZXJGdW5jdGlvbihub2RlKTtcbiAgICAvLyBDaGFuZ2UgZnVuY3Rpb24gdG8gbm90IGJlIGFuIGV4cG9ydFxuICAgIG5vZGUuZmxhZ3MgPSBub2RlLmZsYWdzIF4gQ29tbW9uRmxhZ3MuRVhQT1JUO1xuICAgIHRoaXMud3JhcHBlZEZ1bmNzLmFkZCh0b1N0cmluZyhub2RlLm5hbWUpKTtcbiAgICBzdXBlci52aXNpdChub2RlKTtcbiAgfVxuXG4gIC8qXG4gIENyZWF0ZSBhIHdyYXBwZXIgZnVuY3Rpb24gdGhhdCB3aWxsIGJlIGV4cG9ydCBpbiB0aGUgZnVuY3Rpb24ncyBwbGFjZS5cbiAgKi9cbiAgcHJpdmF0ZSBnZW5lcmF0ZVdyYXBwZXJGdW5jdGlvbihmdW5jOiBGdW5jdGlvbkRlY2xhcmF0aW9uKSB7XG4gICAgbGV0IHNpZ25hdHVyZSA9IGZ1bmMuc2lnbmF0dXJlO1xuICAgIGxldCBwYXJhbXMgPSBzaWduYXR1cmUucGFyYW1ldGVycztcbiAgICBsZXQgcmV0dXJuVHlwZSA9IHNpZ25hdHVyZS5yZXR1cm5UeXBlO1xuICAgIGxldCByZXR1cm5UeXBlTmFtZSA9IHRvU3RyaW5nKHJldHVyblR5cGUpXG4gICAgICAuc3BsaXQoXCJ8XCIpXG4gICAgICAubWFwKG5hbWUgPT4gbmFtZS50cmltKCkpXG4gICAgICAuZmlsdGVyKG5hbWUgPT4gbmFtZSAhPT0gXCJudWxsXCIpXG4gICAgICAuam9pbihcInxcIik7XG4gICAgbGV0IGhhc051bGwgPSB0b1N0cmluZyhyZXR1cm5UeXBlKS5pbmNsdWRlcyhcIm51bGxcIik7XG4gICAgbGV0IG5hbWUgPSBmdW5jLm5hbWUudGV4dDtcblxuICAgIHRoaXMuc2IucHVzaChgZnVuY3Rpb24gX193cmFwcGVyXyR7bmFtZX0oKTogdm9pZCB7YCk7XG4gICAgaWYgKHBhcmFtcy5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLnNiLnB1c2goYCAgY29uc3Qgb2JqID0gZ2V0SW5wdXQoKTtgKTtcbiAgICB9XG4gICAgaWYgKHRvU3RyaW5nKHJldHVyblR5cGUpICE9PSBcInZvaWRcIikge1xuICAgICAgdGhpcy5zYi5wdXNoKGAgIGxldCByZXN1bHQ6ICR7dG9TdHJpbmcocmV0dXJuVHlwZSl9ID0gJHtuYW1lfShgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zYi5wdXNoKGAgICR7bmFtZX0oYCk7XG4gICAgfVxuICAgIGlmIChwYXJhbXMubGVuZ3RoID4gMCkge1xuICAgICAgdGhpcy5zYlt0aGlzLnNiLmxlbmd0aCAtIDFdICs9IHBhcmFtc1xuICAgICAgICAubWFwKHBhcmFtID0+IGNyZWF0ZURlY29kZVN0YXRlbWVudChwYXJhbSkpXG4gICAgICAgIC5qb2luKFwiLCBcIik7XG4gICAgfVxuICAgIHRoaXMuc2JbdGhpcy5zYi5sZW5ndGggLSAxXSArPSBcIik7XCI7XG4gICAgaWYgKHRvU3RyaW5nKHJldHVyblR5cGUpICE9PSBcInZvaWRcIikge1xuICAgICAgdGhpcy5zYi5wdXNoKGAgIGNvbnN0IHZhbCA9IGVuY29kZTwke3JldHVyblR5cGVOYW1lfT4oJHtoYXNOdWxsID8gYGNoYW5nZXR5cGU8JHtyZXR1cm5UeXBlTmFtZX0+KHJlc3VsdClgIDogXCJyZXN1bHRcIn0pO1xuICB2YWx1ZV9yZXR1cm4odmFsLmJ5dGVMZW5ndGgsIHZhbC5kYXRhU3RhcnQpO2ApO1xuICAgIH1cbiAgICB0aGlzLnNiLnB1c2goYH1cbmV4cG9ydCB7IF9fd3JhcHBlcl8ke25hbWV9IGFzICR7bmFtZX0gfWApO1xuICB9XG5cbiAgcHJpdmF0ZSB0eXBlTmFtZSh0eXBlOiBUeXBlTm9kZSB8IENsYXNzRGVjbGFyYXRpb24pOiBzdHJpbmcge1xuICAgIGlmICghaXNDbGFzcyh0eXBlKSkge1xuICAgICAgcmV0dXJuIHRvU3RyaW5nKHR5cGUpO1xuICAgIH1cbiAgICB0eXBlID0gPENsYXNzRGVjbGFyYXRpb24+dHlwZTtcbiAgICBsZXQgY2xhc3NOYW1lID0gdG9TdHJpbmcodHlwZS5uYW1lKTtcbiAgICBpZiAodHlwZS5pc0dlbmVyaWMpIHtcbiAgICAgIGNsYXNzTmFtZSArPSBcIjxcIiArIHR5cGUudHlwZVBhcmFtZXRlcnMhLm1hcCh0b1N0cmluZykuam9pbihcIiwgXCIpICsgXCI+XCI7XG4gICAgfVxuICAgIHJldHVybiBjbGFzc05hbWU7XG4gIH1cblxuICBidWlsZChzb3VyY2U6IFNvdXJjZSk6IHN0cmluZyB7XG4gICAgY29uc3QgaXNOZWFyRmlsZSA9IHNvdXJjZS50ZXh0LmluY2x1ZGVzKFwiQG5lYXJmaWxlXCIpXG4gICAgdGhpcy5zYiA9IFtdO1xuICAgIHRoaXMudmlzaXQoc291cmNlKTtcbiAgICBcbiAgICBsZXQgc291cmNlVGV4dCA9IHNvdXJjZS5zdGF0ZW1lbnRzLm1hcChzdG10ID0+IHtcbiAgICAgIGxldCBzdHI7XG4gICAgICBpZiAoXG4gICAgICAgIGlzQ2xhc3Moc3RtdCkgJiZcbiAgICAgICAgKHV0aWxzLmhhc0RlY29yYXRvcig8Q2xhc3NEZWNsYXJhdGlvbj5zdG10LCBORUFSX0RFQ09SQVRPUikgfHwgaXNOZWFyRmlsZSlcbiAgICAgICAgKSB7XG4gICAgICAgIGxldCBfY2xhc3MgPSA8Q2xhc3NEZWNsYXJhdGlvbj5zdG10O1xuICAgICAgICBsZXQgZmllbGRzID0gX2NsYXNzLm1lbWJlcnNcbiAgICAgICAgLmZpbHRlcihpc0ZpZWxkKVxuICAgICAgICAubWFwKChmaWVsZDogRmllbGREZWNsYXJhdGlvbikgPT4gZmllbGQpO1xuICAgICAgICBpZiAoZmllbGRzLnNvbWUoKGZpZWxkKSA9PiBmaWVsZC50eXBlID09IG51bGwpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQWxsIEZpZWxkcyBtdXN0IGhhdmUgZXhwbGljdCB0eXBlIGRlY2xhcmF0aW9uLlwiKTtcbiAgICAgICAgfVxuICAgICAgICBmaWVsZHMuZm9yRWFjaCggZmllbGQgPT4ge1xuICAgICAgICAgIGlmIChmaWVsZC5pbml0aWFsaXplciA9PSBudWxsKSB7XG4gICAgICAgICAgICBmaWVsZC5pbml0aWFsaXplciA9IFNpbXBsZVBhcnNlci5wYXJzZUV4cHJlc3Npb24oYGRlZmF1bHRWYWx1ZTwke3RvU3RyaW5nKGZpZWxkLnR5cGUhKX0+KCkpYCk7IFxuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICAgc3RyID0gdG9TdHJpbmcoc3RtdCk7XG4gICAgICAgIHN0ciA9IHN0ci5zbGljZSgwLCBzdHIubGFzdEluZGV4T2YoXCJ9XCIpKTtcbiAgICAgICAgbGV0IGNsYXNzTmFtZSA9IHRoaXMudHlwZU5hbWUoX2NsYXNzKTtcbiAgICAgICAgaWYgKCF1dGlscy5oYXNEZWNvcmF0b3IoPENsYXNzRGVjbGFyYXRpb24+c3RtdCwgTkVBUl9ERUNPUkFUT1IpKSB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcIlxceDFiWzMxbVwiLCBgQG5lYXJmaWxlIGlzIGRlcHJlY2F0ZWQgdXNlIEAke05FQVJfREVDT1JBVE9SfSBkZWNvcmF0b3Igb24gJHtjbGFzc05hbWV9YCxcIlxceDFiWzBtXCIpO1xuICAgICAgICB9XG4gICAgICAgIHN0ciArPSBgXG4gIGRlY29kZTxfViA9IFVpbnQ4QXJyYXk+KGJ1ZjogX1YpOiAke2NsYXNzTmFtZX0ge1xuICAgIGxldCBqc29uOiBKU09OLk9iajtcbiAgICBpZiAoYnVmIGluc3RhbmNlb2YgVWludDhBcnJheSkge1xuICAgICAganNvbiA9IEpTT04ucGFyc2UoYnVmKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYXNzZXJ0KGJ1ZiBpbnN0YW5jZW9mIEpTT04uT2JqLCBcImFyZ3VtZW50IG11c3QgYmUgVWludDhBcnJheSBvciBKc29uIE9iamVjdFwiKTtcbiAgICAgIGpzb24gPSA8SlNPTi5PYmo+IGJ1ZjtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuX2RlY29kZShqc29uKTtcbiAgfVxuXG4gIHN0YXRpYyBkZWNvZGUoYnVmOiBVaW50OEFycmF5KTogJHtjbGFzc05hbWV9IHtcbiAgICByZXR1cm4gZGVjb2RlPCR7Y2xhc3NOYW1lfT4oYnVmKTtcbiAgfVxuXG4gIHByaXZhdGUgX2RlY29kZShvYmo6IEpTT04uT2JqKTogJHtjbGFzc05hbWV9IHtcbiAgICAke2NyZWF0ZURlY29kZVN0YXRlbWVudHMoX2NsYXNzKS5qb2luKFwiXFxuICAgIFwiKX1cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIF9lbmNvZGUobmFtZTogc3RyaW5nIHwgbnVsbCA9IFwiXCIsIF9lbmNvZGVyOiBKU09ORW5jb2RlciB8IG51bGwgPSBudWxsKTogSlNPTkVuY29kZXIge1xuICAgIGxldCBlbmNvZGVyID0gX2VuY29kZXIgPT0gbnVsbCA/IG5ldyBKU09ORW5jb2RlcigpIDogX2VuY29kZXI7XG4gICAgZW5jb2Rlci5wdXNoT2JqZWN0KG5hbWUpO1xuICAgICR7Y3JlYXRlRW5jb2RlU3RhdGVtZW50cyhfY2xhc3MpLmpvaW4oXCJcXG4gICAgXCIpfVxuICAgIGVuY29kZXIucG9wT2JqZWN0KCk7XG4gICAgcmV0dXJuIGVuY29kZXI7XG4gIH1cbiAgZW5jb2RlKCk6IFVpbnQ4QXJyYXkge1xuICAgIHJldHVybiB0aGlzLl9lbmNvZGUoKS5zZXJpYWxpemUoKTtcbiAgfVxuXG4gIHNlcmlhbGl6ZSgpOiBVaW50OEFycmF5IHtcbiAgICByZXR1cm4gdGhpcy5lbmNvZGUoKTtcbiAgfVxuXG4gIHRvSlNPTigpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLl9lbmNvZGUoKS50b1N0cmluZygpO1xuICB9XG59YDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHN0ciA9IHRvU3RyaW5nKHN0bXQpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHN0cjtcbiAgICB9KTtcbiAgICByZXR1cm4gc291cmNlVGV4dC5jb25jYXQodGhpcy5zYikuam9pbihcIlxcblwiKTtcbiAgfVxufVxuIl19