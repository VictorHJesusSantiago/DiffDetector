Rails.application.routes.draw do
  get '/api/products', to: 'products#index'
  post '/api/products', to: 'products#create'
end
