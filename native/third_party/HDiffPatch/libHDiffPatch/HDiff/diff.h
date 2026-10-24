//diff.h
//
/*
 The MIT License (MIT)
 Copyright (c) 2012-2018 HouSisong
 
 Permission is hereby granted, free of charge, to any person
 obtaining a copy of this software and associated documentation
 files (the "Software"), to deal in the Software without
 restriction, including without limitation the rights to use,
 copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the
 Software is furnished to do so, subject to the following
 conditions:
 
 The above copyright notice and this permission notice shall be
 included in all copies or substantial portions of the Software.
 
 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 OTHER DEALINGS IN THE SOFTWARE.
*/

#ifndef HDiff_diff_h
#define HDiff_diff_h
#include <vector>
#include "diff_types.h"
#include "../HPatch/checksum_plugin.h"

static const int kMinSingleMatchScore_default = 4;

//create a diff data between oldData and newData
//  out_diff is uncompressed, you can use create_compressed_diff()
//       or create_single_compressed_diff() create compressed diff data
//  kMinSingleMatchScore: default 4, bin: 0--4  text: 4--9
//  isUseBigCacheMatch: big cache uses up to O(oldSize) memory, match speed is faster, but building the big cache is slow
//  NOTE: create_diff() + patch() or patch_stream() or patch_stream_with_cache() is DEPRECATED,
//    recommend changing to use create_single_compressed_diff() + patch_single_stream() or patch_single_compressed_diff()
void create_diff(const unsigned char* newData,const unsigned char* newData_end,
                 const unsigned char* oldData,const unsigned char* oldData_end,
                 std::vector<unsigned char>& out_diff,
                 int kMinSingleMatchScore=kMinSingleMatchScore_default,
                 bool isUseBigCacheMatch=false,size_t threadNum=1);

//return patch(oldData+diff)==newData?
bool check_diff(const unsigned char* newData,const unsigned char* newData_end,
                const unsigned char* oldData,const unsigned char* oldData_end,
                const unsigned char* diff,const unsigned char* diff_end);
bool check_diff(const hpatch_TStreamInput*  newData,
                const hpatch_TStreamInput*  oldData,
                const hpatch_TStreamInput*  diff);


// create_*_diff*() == get_match_covers_by_*() + serialize_*_diff()

//create a compressed diff data between oldData and newData
//  out_diff compressed by compressPlugin
//  recommended to always use create_single_compressed_diff() to replace create_compressed_diff()
//  kMinSingleMatchScore: default 4, bin: 0--4  text: 4--9
//  isUseBigCacheMatch: big cache uses up to O(oldSize) memory, match speed is faster, but building the big cache is slow
void create_compressed_diff(const unsigned char* newData,const unsigned char* newData_end,
                            const unsigned char* oldData,const unsigned char* oldData_end,
                            std::vector<unsigned char>& out_diff,
                            const hdiff_TCompress* compressPlugin=0,
                            int kMinSingleMatchScore=kMinSingleMatchScore_default,
                            bool isUseBigCacheMatch=false,size_t threadNum=1);
void create_compressed_diff(const unsigned char* newData,const unsigned char* newData_end,
                            const unsigned char* oldData,const unsigned char* oldData_end,
                            const hpatch_TStreamOutput* out_diff,
                            const hdiff_TCompress* compressPlugin=0,
                            int kMinSingleMatchScore=kMinSingleMatchScore_default,
                            bool isUseBigCacheMatch=false,size_t threadNum=1);

//create a compressed diff data by stream:
//  can control memory requirements and run speed via different kMatchBlockSize values,
//      but out_diff size is larger than create_compressed_diff()
//  recommended for use in memory-limited environments or for large files
//  recommended to always use create_single_compressed_diff_stream() to replace create_compressed_diff_stream()
//  kMatchBlockSize: recommended (1<<4)--(1<<14)
//    increasing kMatchBlockSize runs faster and uses less memory, but increases out_diff size
//  NOTICE: out_diff->write()'s writeToPos may be back to update headData!
//  throw std::runtime_error when I/O error,etc.
static const size_t kMatchBlockSize_default = (1<<6);
static const size_t kMatchBlockSize_min=4;
void create_compressed_diff_stream(const hpatch_TStreamInput*  newData,
                                   const hpatch_TStreamInput*  oldData,
                                   const hpatch_TStreamOutput* out_diff,
                                   const hdiff_TCompress* compressPlugin=0,
                                   size_t kMatchBlockSize=kMatchBlockSize_default,
                                   const hdiff_TMTSets_s* mtsets=0);


static const size_t kDefaultFastMatchBlockSize = 1024*1;

static const size_t kMatchWindowsBlockSize_default = (1<<6);
static const size_t kDefaultBigCoverSize = 1024*16;
static const size_t kDefaultWindowOldSize = 1024*1024*2;
static const size_t kDefaultSegRatioInWindowOldSize = 64; // default segSize=kOldWindowSize/kDefaultSegRatioInWindowOldSize

//create a compressed diff data by window mode:
//  optimize the access speed of old data when patch
//  kOldWindowSize: max window bytes on old data;
//  kSegSize: initial data granularity in a window matching, if set to 0, the default is used;
//  throw std::runtime_error when I/O error or kSegSize too large,etc.
void create_compressed_diff_window(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                                   const hpatch_TStreamOutput* out_diff,
                                   const hdiff_TCompress* compressPlugin=0,
                                   size_t kOldWindowSize=kDefaultWindowOldSize,size_t kSegSize=0,
                                   size_t kBigCoverSize=kDefaultBigCoverSize,size_t kMatchBlockSize=kMatchWindowsBlockSize_default,
                                   size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                   int kMinSingleMatchScore=kMinSingleMatchScore_default,bool isUseBigCacheMatch=false,
                                   const hdiff_TMTSets_s* mtsets=0,bool isExtendCover=true);

//return patch_decompress(oldData+diff)==newData?
bool check_compressed_diff(const unsigned char* newData,const unsigned char* newData_end,
                           const unsigned char* oldData,const unsigned char* oldData_end,
                           const unsigned char* diff,const unsigned char* diff_end,
                           hpatch_TDecompress* decompressPlugin);
bool check_compressed_diff(const hpatch_TStreamInput*  newData,
                           const hpatch_TStreamInput*  oldData,
                           const hpatch_TStreamInput*  compressed_diff,
                           hpatch_TDecompress* decompressPlugin);

//resave compressed_diff
//  decompress in_diff and recompress to out_diff
//  throw std::runtime_error when input file error or I/O error,etc.
void resave_compressed_diff(const hpatch_TStreamInput*  in_diff,
                            hpatch_TDecompress*         decompressPlugin,
                            const hpatch_TStreamOutput* out_diff,
                            const hdiff_TCompress*      compressPlugin,
                            hpatch_StreamPos_t          out_diff_curPos=0);




static const size_t kDefaultPatchStepMemSize =1024*256;

//create a diff data between oldData and newData, the diffData saved as single compressed stream
//  kMinSingleMatchScore: default 4, bin: 0--4  text: 4--9
//  patchStepMemSize>=hpatch_kStreamCacheSize, default 256k, recommended 64k,2m etc...
//  isUseBigCacheMatch: big cache uses up to O(oldSize) memory, match speed is faster, but building the big cache is slow
void create_single_compressed_diff(const unsigned char* newData,const unsigned char* newData_end,
                                   const unsigned char* oldData,const unsigned char* oldData_end,
                                   std::vector<unsigned char>& out_diff,const hdiff_TCompress* compressPlugin=0,
                                   size_t patchStepMemSize=kDefaultPatchStepMemSize,
                                   int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                   bool isUseBigCacheMatch=false,size_t threadNum=1);
void create_single_compressed_diff(const unsigned char* newData,const unsigned char* newData_end,
                                   const unsigned char* oldData,const unsigned char* oldData_end,
                                   const hpatch_TStreamOutput* out_diff,const hdiff_TCompress* compressPlugin=0,
                                   size_t patchStepMemSize=kDefaultPatchStepMemSize,
                                   int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                   bool isUseBigCacheMatch=false,size_t threadNum=1);
//create single compressed diff data by stream:
//  can control memory requirements and run speed via different kMatchBlockSize values,
//      but out_diff size is larger than create_single_compressed_diff()
//  recommended for use in memory-limited environments or for large files
//  kMatchBlockSize: recommended (1<<4)--(1<<14)
//    increasing kMatchBlockSize runs faster and uses less memory, but increases out_diff size
//  NOTICE: out_diff->write()'s writeToPos may be back to update headData!
//  throw std::runtime_error when I/O error,etc.
void create_single_compressed_diff_stream(const hpatch_TStreamInput*  newData,
                                          const hpatch_TStreamInput*  oldData,
                                          const hpatch_TStreamOutput* out_diff,
                                          const hdiff_TCompress* compressPlugin=0,
                                          size_t patchStepMemSize=kDefaultPatchStepMemSize,
                                          size_t kMatchBlockSize=kMatchBlockSize_default,
                                          const hdiff_TMTSets_s* mtsets=0);

//create single compressed diff data by window mode:
//  optimize the access speed of old data when patch
//  kOldWindowSize: max window bytes on old data;
//  kSegSize: initial data granularity during window matching, if set to 0, the default is used;
//  throw std::runtime_error when I/O error or kSegSize too large,etc.
void create_single_compressed_diff_window(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                                          const hpatch_TStreamOutput* out_diff,
                                          const hdiff_TCompress* compressPlugin=0,
                                          size_t patchStepMemSize=kDefaultPatchStepMemSize,
                                          size_t kOldWindowSize=kDefaultWindowOldSize,size_t kSegSize=0,
                                          size_t kBigCoverSize=kDefaultBigCoverSize,size_t kMatchBlockSize=kMatchWindowsBlockSize_default,
                                          size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                          int kMinSingleMatchScore=kMinSingleMatchScore_default,bool isUseBigCacheMatch=false,
                                          const hdiff_TMTSets_s* mtsets=0,bool isExtendCover=true);

//return patch_single_?(oldData+diff)==newData?
bool check_single_compressed_diff(const unsigned char* newData,const unsigned char* newData_end,
                                  const unsigned char* oldData,const unsigned char* oldData_end,
                                  const unsigned char* diff,const unsigned char* diff_end,
                                  hpatch_TDecompress* decompressPlugin,size_t threadNum=1);
bool check_single_compressed_diff(const hpatch_TStreamInput* newData,
                                  const hpatch_TStreamInput* oldData,
                                  const hpatch_TStreamInput* diff,
                                  hpatch_TDecompress* decompressPlugin,size_t threadNum=1);

//resave single_compressed_diff
//  decompress in_diff and recompress to out_diff
//  throw std::runtime_error when input file error or I/O error,etc.
//  return new out_diff curPos
hpatch_StreamPos_t
     resave_single_compressed_diff(const hpatch_TStreamInput*  in_diff,
                                   hpatch_TDecompress*         decompressPlugin,
                                   const hpatch_TStreamOutput* out_diff,
                                   const hdiff_TCompress*      compressPlugin,
                                   const hpatch_singleCompressedDiffInfo* diffInfo=0,
                                   hpatch_StreamPos_t          in_diff_curPos=0,
                                   hpatch_StreamPos_t          out_diff_curPos=0);


//optimize diff speed by match block
//   get_match_covers_by_stream() got big covers + get_match_covers_by_sstring() got small covers
//   if (fastMatchBlockSize==0), not used get_match_covers_by_stream()
//see create_compressed_diff | create_single_compressed_diff
void create_compressed_diff_block(const hpatch_TStreamInput* newData,//will load needed in memory
                                  const hpatch_TStreamInput* oldData,//will load needed in memory
                                  const hpatch_TStreamOutput* out_diff,
                                  const hdiff_TCompress* compressPlugin=0,
                                  size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                  int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                  bool isUseBigCacheMatch=false,const hdiff_TMTSets_s* mtsets=0);
//note: newData&oldData in memory will be changed
void create_compressed_diff_block(unsigned char* newData,unsigned char* newData_end,
                                  unsigned char* oldData,unsigned char* oldData_end,
                                  const hpatch_TStreamOutput* out_diff,
                                  const hdiff_TCompress* compressPlugin=0,
                                  size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                  int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                  bool isUseBigCacheMatch=false,size_t threadNum=1);
void create_compressed_diff_block(unsigned char* newData,unsigned char* newData_end,
                                  unsigned char* oldData,unsigned char* oldData_end,
                                  std::vector<unsigned char>& out_diff,
                                  const hdiff_TCompress* compressPlugin=0,
                                  size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                  int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                  bool isUseBigCacheMatch=false,size_t threadNum=1);

void create_single_compressed_diff_block(const hpatch_TStreamInput* newData,//will load needed in memory
                                         const hpatch_TStreamInput* oldData,//will load needed in memory
                                         const hpatch_TStreamOutput* out_diff,const hdiff_TCompress* compressPlugin=0,
                                         size_t patchStepMemSize=kDefaultPatchStepMemSize,
                                         size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                         int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                         bool isUseBigCacheMatch=false,const hdiff_TMTSets_s* mtsets=0);
void create_single_compressed_diff_block(unsigned char* newData,unsigned char* newData_end,
                                         unsigned char* oldData,unsigned char* oldData_end,
                                         const hpatch_TStreamOutput* out_diff,const hdiff_TCompress* compressPlugin=0,
                                         size_t patchStepMemSize=kDefaultPatchStepMemSize,
                                         size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                         int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                         bool isUseBigCacheMatch=false,size_t threadNum=1);
void create_single_compressed_diff_block(unsigned char* newData,unsigned char* newData_end,
                                         unsigned char* oldData,unsigned char* oldData_end,
                                         std::vector<unsigned char>& out_diff,const hdiff_TCompress* compressPlugin=0,
                                         size_t patchStepMemSize=kDefaultPatchStepMemSize,
                                         size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                         int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                         bool isUseBigCacheMatch=false,size_t threadNum=1);

//create window diff data between oldData and newData:
//  kMatchBlockSize: recommended (1<<4)--(1<<14)
//    if (kMatchBlockSize==0) diff by sstring, else diff by stream(for large file)
//  kOldWindowSize: max window bytes on old data;
//    requires kOldWindowSize + patchStepMemSize + (I/O cache memory) when patch;
//  kSegSize: initial data granularity in a window matching, if set to 0, the default is used;
//    recommended kOldWindowSize/128<=kSegSize<=kOldWindowSize/4;
//  kBigCoverSize: skip big covers when rematching in a window, for optimizing diff speed;
//  NOTICE: out_diff->write()'s writeToPos may be back to update headData!
//  throw std::runtime_error when I/O error or kSegSize too large,etc.
void create_window_diff(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                        const hpatch_TStreamOutput* out_diff,
                        const hdiff_TCompress* compressPlugin,hpatch_TChecksum* checksumPlugin,
                        size_t patchStepMemSize=kDefaultPatchStepMemSize,
                        size_t kOldWindowSize=kDefaultWindowOldSize,size_t kSegSize=0,
                        size_t kBigCoverSize=kDefaultBigCoverSize,size_t kMatchBlockSize=kMatchWindowsBlockSize_default,
                        size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                        int kMinSingleMatchScore=kMinSingleMatchScore_default,bool isUseBigCacheMatch=false,
                        const hdiff_TMTSets_s* mtsets=0,bool isExtendCover=true);

TWindowPatchResult check_window_diff(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                                     const hpatch_TStreamInput* diffData,hpatch_TDecompress* decompressPlugin,
                                     hpatch_TChecksum* checksumPlugin,size_t threadNum=1);

//resave window_diff
hpatch_StreamPos_t resave_window_diff(const hpatch_TStreamInput*  in_diff,
                                      hpatch_TDecompress*         decompressPlugin,
                                      const hpatch_TStreamOutput* out_diff,
                                      const hdiff_TCompress*      compressPlugin,
                                      hpatch_TChecksum*           checksumPlugin,
                                      const hpatch_windowDiffInfo* diffInfo=0,
                                      hpatch_StreamPos_t          in_diff_curPos=0,
                                      hpatch_StreamPos_t          out_diff_curPos=0);


//same as create?compressed_diff_stream(), but not serialize diffData, only got covers
//  now isExtendCover is always false, so it does not need to be passed
void get_match_covers_by_stream(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                                std::vector<TCover>& out_covers,size_t kMatchBlockSize=kMatchBlockSize_default,
                                const hdiff_TMTSets_s* mtsets=0);
void get_match_covers_by_stream(const unsigned char* newData,const unsigned char* newData_end,
                                const unsigned char* oldData,const unsigned char* oldData_end,
                                std::vector<TCover>& out_covers,size_t kMatchBlockSize=kMatchBlockSize_default,
                                size_t threadNum=1);

//same as create?_diff(), but not serialize diffData, only got covers
void get_match_covers_by_sstring(const unsigned char* newData,const unsigned char* newData_end,
                                 const unsigned char* oldData,const unsigned char* oldData_end,
                                 std::vector<TCover>& out_covers,
                                 int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                 bool isUseBigCacheMatch=false,size_t threadNum=1,
                                 bool isExtendCover=true,ICoverLinesListener* listener=0);

// get_match_covers_by_stream() got big covers + get_match_covers_by_sstring() got small covers
void get_match_covers_by_stream_and_sstring(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                                            std::vector<TCover>& out_covers,size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                            int kMinSingleMatchScore=kMinSingleMatchScore_default,bool isUseBigCacheMatch=false,
                                            const hdiff_TMTSets_s* mtsets=0,bool isExtendCover=true,TCachedNewOldStreams* out_cachedStreams=0);
//NOTE: newData,oldData's memory data will be edit
void get_match_covers_by_stream_and_sstring(unsigned char* newData,unsigned char* newData_end,
                                            unsigned char* oldData,unsigned char* oldData_end,
                                            std::vector<TCover>& out_covers,size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                            int kMinSingleMatchScore=kMinSingleMatchScore_default,bool isUseBigCacheMatch=false,
                                            size_t threadNum=1,bool isExtendCover=true);


//same as create?compressed_diff_window(), but not serialize diffData, only got covers
// (get_match_covers_by_stream() or get_match_covers_by_sstring()) + get_match_windows_from_baseCovers() + loop get_match_covers_in_a_window()
// if (kMatchBlockSize!=0) get_match_covers_by_stream(out baseCovers) else get_match_covers_by_sstring(out baseCovers);
// throw std::runtime_error when I/O error or kSegSize too large,etc.
void get_match_covers_by_window(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                                size_t kNewWindowSize,size_t kOldWindowSize,size_t kSegSize,std::vector<TCover>& out_covers,
                                size_t kBigCoverSize=kDefaultBigCoverSize,size_t kMatchBlockSize=kMatchWindowsBlockSize_default,
                                size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                int kMinSingleMatchScore=kMinSingleMatchScore_default,bool isUseBigCacheMatch=false,
                                const hdiff_TMTSets_s* mtsets=0,bool isExtendCover=true);

void get_match_covers_and_window(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                                 size_t kNewWindowSize,size_t kOldWindowSize,size_t kSegSize,bool isCollateMergeCover,
                                 std::vector<TCover>& out_covers,std::vector<hpatch_TWindow>& out_windows,
                                 size_t kBigCoverSize=kDefaultBigCoverSize,size_t kMatchBlockSize=kMatchWindowsBlockSize_default,
                                 size_t fastMatchBlockSize=kDefaultFastMatchBlockSize,
                                 int kMinSingleMatchScore=kMinSingleMatchScore_default,bool isUseBigCacheMatch=false,
                                 const hdiff_TMTSets_s* mtsets=0,bool isExtendCover=true);

void get_match_windows_from_baseCovers(hpatch_StreamPos_t newSize,hpatch_StreamPos_t oldSize,
                                       size_t kNewWindowSize,size_t kOldWindowSize,size_t kSegSize,//if (kSegSize==0) mean used default;
                                       std::vector<TCover>& baseCovers,std::vector<hpatch_TWindow>& out_windows,
                                       std::vector<std::vector<TCover> >& out_bigCoverss,size_t kBigCoverSize);
void get_match_covers_in_a_window(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                                  hpatch_TWindow& window,const std::vector<TCover>& bigCovers,
                                  std::vector<TCover>& out_covers,int kMinSingleMatchScore=kMinSingleMatchScore_default,
                                  bool isUseBigCacheMatch=false,size_t threadNum=1,bool isExtendCover=true);


//covers type TInputCovers, can pass std::vector<TCover>
// if (!isExtendCover), does not read oldStream's data, only uses oldStream->streamSize
void serialize_compressed_diff(const hpatch_TStreamInput* newData,const hpatch_TStreamInput* oldData,
                               const TInputCovers& covers,const hpatch_TStreamOutput* out_diff,
                               const hdiff_TCompress* compressPlugin,bool isExtendCover);
void serialize_single_compressed_diff(const hpatch_TStreamInput* newStream,const hpatch_TStreamInput* oldStream,
                                      const TInputCovers& covers,const hpatch_TStreamOutput* out_diff,
                                      const hdiff_TCompress* compressPlugin,size_t patchStepMemSize,bool isExtendCover);
void serialize_window_diff(const hpatch_TStreamInput* newStream,const hpatch_TStreamInput* oldStream,
                           const TInputCovers& covers,const std::vector<hpatch_TWindow>& windows,
                           const hpatch_TStreamOutput* out_diff,const hdiff_TCompress* compressPlugin,
                           hpatch_TChecksum* checksumPlugin,size_t patchStepMemSize,bool isExtendCover);

#endif
