//covers_range.h
//
/*
 The MIT License (MIT)
 Copyright (c) 2025-2026 HouSisong
 
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
#ifndef covers_range_h
#define covers_range_h
#include "../../diff_types.h"
#include <string.h>
namespace hdiff_private{

struct TCoversRange{
    //TCoversRange
    const TCover*       cover_begin;
    const TCover*       cover_end;
    unsigned char*      coverValid_begin;  //validity flag per cover: 1=valid,0=invalid
    hpatch_TWindow      window;
	inline TCoversRange(){ memset(this,0,sizeof(*this)); }
    inline explicit TCoversRange(const TCover* _cover_begin,const TCover* _cover_end)
     :cover_begin(_cover_begin),cover_end(_cover_end),coverValid_begin(0)
      { memset(&window,0,sizeof(window)); }
    inline explicit TCoversRange(const TCover* _cover_begin,const TCover* _cover_end,unsigned char* _coverValid_begin)
     :cover_begin(_cover_begin),cover_end(_cover_end),coverValid_begin(_coverValid_begin)
      { memset(&window,0,sizeof(window)); }
    inline TCoversRange(const TCoversRange& b) { *this=b; }
    inline bool operator < (const TCoversRange& b)const { return cover_begin < b.cover_begin; }
};


//clip by oldWindowSize
void clipRangeByOld(std::vector<TCoversRange>& ranges,hpatch_StreamPos_t oldWindowSize,
                    const TCover* cover,const TCover* cover_end,unsigned char* valid,hpatch_StreamPos_t kSegSize);

//clip by newWindowSize
void clipRangeByNew(std::vector<TCoversRange>& ranges,size_t newWindowSize);

}//namespace hdiff_private

#endif // covers_range_h