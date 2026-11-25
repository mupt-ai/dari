#import <Foundation/Foundation.h>
#import <CoreML/CoreML.h>
#include <nanobind/nanobind.h>
#include <nanobind/stl/string.h>
#include <nanobind/stl/vector.h>
#include <mlx/mlx.h>
#include <mlx/primitives.h>
#include <mlx/backend/cpu/encoder.h>
#include <cstring>
#include <stdexcept>
namespace mx=mlx::core;
namespace nb=nanobind;
static void fail(NSError *e) { throw std::runtime_error(e ? e.localizedDescription.UTF8String : "Core ML operation failed"); }
static MLMultiArray *view(void *ptr,int r,int c,NSError **err) {
  return [[MLMultiArray alloc] initWithDataPointer:ptr shape:@[@1,@1,@(r),@(c)] dataType:MLMultiArrayDataTypeFloat16 strides:@[@(r*c),@(r*c),@(c),@1] deallocator:^(void*){} error:err];
}
struct Projection {
  MLModel *model; NSArray<NSString*> *names; NSString *output; int r,n; std::vector<std::pair<int,int>> dims;
  explicit Projection(const std::string& path) { @autoreleasepool {
    NSError *err=nil; MLModelConfiguration *cfg=[MLModelConfiguration new]; cfg.computeUnits=MLComputeUnitsCPUAndNeuralEngine;
    model=[MLModel modelWithContentsOfURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]] configuration:cfg error:&err];if(!model)fail(err);
    auto ins=model.modelDescription.inputDescriptionsByName,outs=model.modelDescription.outputDescriptionsByName;
    if(!ins.count || outs.count!=1)throw std::invalid_argument("Expected one Core ML output");
    names=[ins.allKeys sortedArrayUsingSelector:@selector(compare:)];output=outs.allKeys.firstObject;
    auto dimsOf=[](MLMultiArrayConstraint *a){if(a.dataType!=MLMultiArrayDataTypeFloat16 || a.shape.count!=4 || a.shape[0].intValue!=1 || a.shape[1].intValue!=1)throw std::invalid_argument("Expected fixed 1x1xRxD float16 array");return std::pair{a.shape[2].intValue,a.shape[3].intValue};};
    for(NSString *name in names)dims.push_back(dimsOf(ins[name].multiArrayConstraint)); std::tie(r,n)=dimsOf(outs[output].multiArrayConstraint);
  }}
  void predict(std::vector<mx::array>& xs,void* y) const { @autoreleasepool {
    NSError *err=nil; NSMutableDictionary *dict=[NSMutableDictionary new];
    for(size_t i=0;i<xs.size();i++){auto a=view(xs[i].data<void>(),dims[i].first,dims[i].second,&err);if(!a)fail(err);dict[names[i]]=[MLFeatureValue featureValueWithMultiArray:a];}
    auto b=view(y,r,n,&err);if(!b)fail(err);auto feed=[[MLDictionaryFeatureProvider alloc] initWithDictionary:dict error:&err];if(!feed)fail(err);
    MLPredictionOptions *options=[MLPredictionOptions new]; options.outputBackings=@{output:b};
    auto result=[model predictionFromFeatures:feed options:options error:&err];if(!result)fail(err);
    auto out=[result featureValueForName:output].multiArrayValue;if(!out || ![out.shape isEqual:b.shape] || out.dataType!=b.dataType)throw std::runtime_error("Unexpected Core ML output");
    if(out!=b){NSInteger nr=r,nc=n;[out getBytesWithHandler:^(const void *p, NSInteger bytes){auto src=static_cast<const uint16_t*>(p);auto dst=static_cast<uint16_t*>(y);auto sr=out.strides[2].integerValue,sc=out.strides[3].integerValue;if(sr<0 || sc<0 || ((nr-1)*sr+(nc-1)*sc+1)*2>bytes)throw std::runtime_error("Invalid output strides");for(NSInteger i=0;i<nr;i++){if(sc==1)std::memcpy(dst+i*nc,src+i*sr,nc*2);else for(NSInteger j=0;j<nc;j++)dst[i*nc+j]=src[i*sr+j*sc];}}];}
  }}
};
class ANEOp:public mx::UnaryPrimitive {
 std::shared_ptr<Projection> model_;
 public: ANEOp(mx::Stream s,std::shared_ptr<Projection> model):mx::UnaryPrimitive(s),model_(std::move(model)){}
 const char*name() const override{return "InklingANEProjection";}
 void eval_gpu(const std::vector<mx::array>&,mx::array&)override{throw std::logic_error("Expected a CPU command stream");}
 void eval_cpu(const std::vector<mx::array>& inputs,mx::array& out) override {
   out.set_data(mx::allocator::malloc(out.nbytes()));auto& e=mx::cpu::get_command_encoder(stream());for(auto& x:inputs){if(!x.flags().row_contiguous)throw std::invalid_argument("ANE input must be row contiguous");e.set_input_array(x);}e.set_output_array(out);
   e.dispatch([xs=inputs,out,m=model_]()mutable{m->predict(xs,out.data<void>());});
 }
};
struct Layer {
 std::shared_ptr<Projection> model;mx::Stream stream;
 explicit Layer(std::string path):model(std::make_shared<Projection>(path)),stream(mx::default_stream(mx::Device::cpu)){}
 mx::array predict(std::vector<mx::array> xs){if(xs.size()!=model->dims.size())throw std::invalid_argument("Input count mismatch");for(size_t i=0;i<xs.size();i++){auto [r,k]=model->dims[i];if(xs[i].dtype()!=mx::float16 || xs[i].shape()!=mx::Shape{1,r,k})throw std::invalid_argument("Input shape or type mismatch (use alphabetical feature order)");}return mx::array({1,model->r,model->n},mx::float16,std::make_shared<ANEOp>(stream,model),std::move(xs));}
 mx::array apply(mx::array x){return predict({x});}
};
NB_MODULE(_inkling_ane,m){nb::class_<Layer>(m,"Layer").def(nb::init<std::string>()).def("__call__",&Layer::apply).def("predict",&Layer::predict);}
