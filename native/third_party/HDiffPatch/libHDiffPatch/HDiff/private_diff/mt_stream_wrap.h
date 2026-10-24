//  mt_stream_wrap.h
//  MT-safe stream wrappers for HDiffPatch
/*
 The MIT License (MIT)
 Copyright (c) 2024 HouSisong

 Permission is hereby granted, free of charge, to any person
 obtaining a copy of this software and associated documentation
 files (the "Software"), to deal in the Software without
 restriction, including without limitation the rights to use,
 copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the
 Software is furnished to do so, subject to the following
 conditions:

 The above copyright notice and this permission notice shall be
 included in all copies of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 OTHER DEALINGS IN THE SOFTWARE.
 */

#ifndef HDiff_mt_stream_wrap_h
#define HDiff_mt_stream_wrap_h

#include "../../../libParallel/parallel_import.h"
#if (_IS_USED_MULTITHREAD)
#include "../../HPatch/patch_types.h"

namespace hdiff_private {

struct TMTSafeStreamInput {
    hpatch_TStreamInput         base;
    const hpatch_TStreamInput*  srcStream;
    HLocker                     locker;

    static hpatch_BOOL _read(const hpatch_TStreamInput* stream, hpatch_StreamPos_t readFromPos,
                             unsigned char* out_data, unsigned char* out_data_end) {
        TMTSafeStreamInput* self = (TMTSafeStreamInput*)stream->streamImport;
        locker_enter(self->locker);
        hpatch_BOOL result = self->srcStream->read(self->srcStream, readFromPos, out_data, out_data_end);
        locker_leave(self->locker);
        return result;
    }

    inline TMTSafeStreamInput(const hpatch_TStreamInput* src) : srcStream(src) {
        locker = src?locker_new():0;
        base.streamImport = this;
        base.streamSize = src?src->streamSize:0;
        base.read = src?_read:0;
        base._private_reserved = 0;
    }

    inline ~TMTSafeStreamInput() {
        locker_delete(locker);
    }
};

struct TMTSafeStreamOutput {
    hpatch_TStreamOutput         base;
    const hpatch_TStreamOutput*  srcStream;
    HLocker                      locker;

    static hpatch_BOOL _write(const hpatch_TStreamOutput* stream, hpatch_StreamPos_t writeToPos,
                              const unsigned char* data, const unsigned char* data_end) {
        TMTSafeStreamOutput* self = (TMTSafeStreamOutput*)stream->streamImport;
        locker_enter(self->locker);
        hpatch_BOOL result = self->srcStream->write(self->srcStream, writeToPos, data, data_end);
        locker_leave(self->locker);
        return result;
    }

    static hpatch_BOOL _read_writed(const hpatch_TStreamOutput* stream, hpatch_StreamPos_t readFromPos,
                                    unsigned char* out_data, unsigned char* out_data_end) {
        TMTSafeStreamOutput* self = (TMTSafeStreamOutput*)stream->streamImport;
        if (!self->srcStream->read_writed) return hpatch_FALSE;
        locker_enter(self->locker);
        hpatch_BOOL result = self->srcStream->read_writed(self->srcStream, readFromPos, out_data, out_data_end);
        locker_leave(self->locker);
        return result;
    }

    inline TMTSafeStreamOutput(const hpatch_TStreamOutput* src) : srcStream(src) {
        locker = src?locker_new():0;
        base.streamImport = this;
        base.streamSize = src?src->streamSize:0;
        base.read_writed = src?(src->read_writed?_read_writed:0) : 0;
        base.write = _write;
    }

    inline ~TMTSafeStreamOutput() {
        locker_delete(locker);
    }
};

} // namespace hdiff_private

#endif // _IS_USED_MULTITHREAD
#endif // HDiff_mt_stream_wrap_h
